import type { AppConfig } from '@librechat/data-schemas';
import type { RunConfig } from '@librechat/agents';
import {
  hasLangfuseEnvCredentials,
  isLangfuseCentralMediaUploadDisabled,
  isLangfuseFanoutEnabled,
  isLangfuseTenantExportEnabled,
  isLangfuseTraceSampled,
  isLangfuseTracingEnabled,
  usesLangfuseMultiTenantRouting,
} from './policy';
import { normalizeBoolean, resolveLangfuseHeaders, resolveTenantCredentials } from './utils';
import { resolveLangfuseTenantDestination } from './tenantDestinations';
import { scopeHeadersToDestination } from './destinations';
import { normalizeString } from '~/utils/text';
import { traceIdForMessage } from './trace';

type LangfuseRunConfig = NonNullable<RunConfig['langfuse']>;
type LangfuseRunConfigWithTraceAttributes = LangfuseRunConfig & {
  librechatTraceAttributes?: Record<string, string | number | boolean | null | undefined>;
  mediaUploadEnabled?: boolean;
  additionalHeaders?: Record<string, string>;
};
type LangfuseTenantDestination = NonNullable<ReturnType<typeof resolveLangfuseTenantDestination>>;
type LangfuseExportPlan =
  | { type: 'directCentral' }
  | { type: 'disabled' }
  | { type: 'fanoutCollector'; collectorUrl: string }
  | {
      type: 'tenantFanout';
      collectorUrl: string;
      destination: LangfuseTenantDestination;
      publicKey: string;
      secretKey: string;
    };
const TENANT_EXPORT_ATTRIBUTE = 'librechat.langfuse.tenant_export.enabled';
const TENANT_DESTINATION_ATTRIBUTE = 'librechat.langfuse.destination';
const CENTRAL_EXPORT_ATTRIBUTE = 'librechat.langfuse.central_export.enabled';
const CENTRAL_MEDIA_DISABLED_SEGMENT = 'central-media-disabled';
const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export { isLangfuseFanoutEnabled, isLangfuseTenantExportEnabled } from './policy';

function mergeTraceMetadata(
  base: LangfuseRunConfig['metadata'],
  tenantId?: string,
): LangfuseRunConfig['metadata'] | undefined {
  if (!tenantId) {
    return base;
  }
  return {
    ...(base ?? {}),
    'librechat.tenant.id': tenantId,
  };
}

function userIdentityMetadata(
  user?: { email?: string | null; name?: string | null } | null,
): Record<string, string> | undefined {
  if (process.env.LANGFUSE_TRACE_USER_IDENTITY !== 'true' || user == null) {
    return undefined;
  }
  const out: Record<string, string> = {};
  if (typeof user.email === 'string' && user.email.trim() !== '') {
    out.userEmail = user.email;
  }
  if (typeof user.name === 'string' && user.name.trim() !== '') {
    out.userName = user.name;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Human-readable per-user tag, so cost can be **grouped** by person.
 * `metadata` is filter-only in the metrics API — only `tags` is a groupable
 * dimension — and Langfuse `userId` stays the Mongo id (shared runtime
 * identity: MCP, tools, sub-agents), so the email has to ride here.
 *
 * Deliberately the only identity tag: grouping by `tags` groups by the WHOLE
 * array, so a second varying tag would fragment every row into per-combination
 * groups. Agent identity lives in the trace name instead (`runName`).
 *
 * Lowercased so the same person never splits across two groups on casing.
 */
function userIdentityTags(user?: { email?: string | null } | null): string[] | undefined {
  if (process.env.LANGFUSE_TRACE_USER_IDENTITY !== 'true' || user == null) {
    return undefined;
  }
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  return email !== '' ? [`user:${email}`] : undefined;
}

function mergeTags(tags: string[] | undefined, tenantId?: string): string[] | undefined {
  if (!tenantId) {
    return tags;
  }
  return [...new Set([...(tags ?? []), `tenant:${tenantId}`])];
}

function applyCentralEnvConfig(langfuse: LangfuseRunConfigWithTraceAttributes): void {
  const publicKey = normalizeString(process.env.LANGFUSE_PUBLIC_KEY);
  const secretKey = normalizeString(process.env.LANGFUSE_SECRET_KEY);
  if (publicKey && secretKey) {
    langfuse.publicKey = publicKey;
    langfuse.secretKey = secretKey;
    langfuse.baseUrl =
      normalizeString(process.env.LANGFUSE_BASE_URL) ??
      normalizeString(process.env.LANGFUSE_HOST) ??
      normalizeString(process.env.LANGFUSE_BASEURL) ??
      DEFAULT_BASE_URL;
  }
}

/**
 * Attaches the deployment's headers only once the export branch has settled on
 * a `baseUrl`, and only when that origin is one the operator configured.
 *
 * A run resolves to a single destination, but which one depends on the branch —
 * attaching earlier would send a gateway credential to whatever endpoint the
 * config happened to fall through to, including Langfuse Cloud.
 */
function applyCustomHeaders(
  langfuse: LangfuseRunConfigWithTraceAttributes,
  additionalHeaders?: Record<string, string>,
): LangfuseRunConfigWithTraceAttributes {
  if (langfuse.enabled === false || langfuse.baseUrl == null) {
    return langfuse;
  }
  const scoped = scopeHeadersToDestination(additionalHeaders, langfuse.baseUrl);
  if (scoped) {
    langfuse.additionalHeaders = scoped;
  }
  return langfuse;
}

function disableCentralExport(langfuse: LangfuseRunConfigWithTraceAttributes): void {
  langfuse.librechatTraceAttributes = {
    ...(langfuse.librechatTraceAttributes ?? {}),
    [CENTRAL_EXPORT_ATTRIBUTE]: 'false',
  };
}

function resolveLangfuseExportPlan({
  centralTraceExportEnabled,
  fanoutEnabled,
  fanoutCollectorUrl,
  tenantExportEnabled,
  publicKey,
  secretKey,
  tenantDestination,
}: {
  centralTraceExportEnabled: boolean;
  fanoutEnabled: boolean;
  fanoutCollectorUrl?: string;
  tenantExportEnabled: boolean;
  publicKey?: string;
  secretKey?: string;
  tenantDestination?: LangfuseTenantDestination;
}): LangfuseExportPlan {
  if (!fanoutEnabled || fanoutCollectorUrl == null) {
    return centralTraceExportEnabled ? { type: 'directCentral' } : { type: 'disabled' };
  }

  const canRouteTenantFanout =
    tenantExportEnabled && publicKey != null && secretKey != null && tenantDestination != null;

  if (canRouteTenantFanout) {
    return {
      type: 'tenantFanout',
      collectorUrl: fanoutCollectorUrl,
      destination: tenantDestination,
      publicKey,
      secretKey,
    };
  }

  // Direct central export can use the collector normally. Central-suppressed
  // runs only reach the collector through a concrete tenant fanout route.
  if (centralTraceExportEnabled) {
    return { type: 'fanoutCollector', collectorUrl: fanoutCollectorUrl };
  }

  return { type: 'disabled' };
}

export function buildLangfuseConfig({
  appConfig,
  runId,
  tenantId,
  centralTraceExportEnabled = true,
  user,
}: {
  appConfig?: AppConfig;
  runId?: string;
  tenantId?: string;
  /**
   * Defaults to true. Set false to suppress central Langfuse export for this
   * run. Fanout deployments stamp a routing attribute that the collector uses
   * to drop the central pipeline while preserving tenant fanout when available.
   */
  centralTraceExportEnabled?: boolean;
  /**
   * Requesting user, for human-readable identity on traces. Only email/name
   * are read, and only when LANGFUSE_TRACE_USER_IDENTITY=true. Langfuse
   * `userId` stays the Mongo id (it is shared runtime identity — MCP, tools,
   * sub-agents); this puts the readable identity in trace metadata instead.
   */
  user?: { email?: string | null; name?: string | null } | null;
} = {}): LangfuseRunConfig {
  const normalizedTenantId = normalizeString(tenantId);
  const config = appConfig?.langfuse;

  const langfuse: LangfuseRunConfigWithTraceAttributes = {
    deterministicTraceId: true,
  };
  const metadata = mergeTraceMetadata(userIdentityMetadata(user), normalizedTenantId);
  const tags = mergeTags(userIdentityTags(user), normalizedTenantId);
  if (metadata) {
    langfuse.metadata = metadata;
  }
  if (tags) {
    langfuse.tags = tags;
  }

  if (
    !isLangfuseTracingEnabled() ||
    (runId != null && !isLangfuseTraceSampled(traceIdForMessage(runId)))
  ) {
    langfuse.enabled = false;
    return langfuse;
  }

  const additionalHeaders = resolveLangfuseHeaders(config?.headers);

  const tenantLangfuseEnabled = normalizeBoolean(config?.enabled) === true;
  if (!centralTraceExportEnabled) {
    disableCentralExport(langfuse);
  }

  const tenantCredentials = resolveTenantCredentials(config);
  const hasTenantCredentials = Boolean(tenantCredentials);
  const fanoutEnabled = isLangfuseFanoutEnabled();
  const fanoutCollectorUrl = normalizeString(process.env.LANGFUSE_FANOUT_COLLECTOR_URL);
  const tenantDestination = resolveLangfuseTenantDestination(config?.destination);
  const tenantExportEmergencyEnabled = isLangfuseTenantExportEnabled();

  if (!usesLangfuseMultiTenantRouting()) {
    if (!centralTraceExportEnabled) {
      langfuse.enabled = false;
    } else if (hasLangfuseEnvCredentials()) {
      applyCentralEnvConfig(langfuse);
    } else if (tenantLangfuseEnabled && tenantCredentials != null && tenantDestination != null) {
      langfuse.publicKey = tenantCredentials.publicKey;
      langfuse.secretKey = tenantCredentials.secretKey;
      langfuse.baseUrl = tenantDestination.baseUrl;
    } else if (config != null) {
      langfuse.enabled = false;
    }
    return applyCustomHeaders(langfuse, additionalHeaders);
  }

  const exportPlan = resolveLangfuseExportPlan({
    centralTraceExportEnabled,
    fanoutEnabled,
    fanoutCollectorUrl,
    tenantExportEnabled:
      tenantLangfuseEnabled && hasTenantCredentials && tenantExportEmergencyEnabled,
    publicKey: tenantCredentials?.publicKey,
    secretKey: tenantCredentials?.secretKey,
    tenantDestination,
  });

  switch (exportPlan.type) {
    case 'tenantFanout':
      langfuse.publicKey = exportPlan.publicKey;
      langfuse.secretKey = exportPlan.secretKey;
      langfuse.baseUrl = appendPath(
        exportPlan.collectorUrl,
        [
          '',
          'tenant',
          exportPlan.destination.key,
          ...(!centralTraceExportEnabled ? [CENTRAL_MEDIA_DISABLED_SEGMENT] : []),
        ].join('/'),
      );
      // Fanout routing stays destination-scoped by URL. `additionalHeaders` is
      // now available (and carries the deployment's proxy headers), but routing
      // multiple tenant Langfuse exports for one run by header would need the
      // collector to demultiplex them — the URL remains the app-to-gateway
      // routing contract until that is required.
      langfuse.librechatTraceAttributes = {
        ...(langfuse.librechatTraceAttributes ?? {}),
        [TENANT_EXPORT_ATTRIBUTE]: 'true',
        [TENANT_DESTINATION_ATTRIBUTE]: exportPlan.destination.key,
      };
      break;
    case 'fanoutCollector':
      langfuse.baseUrl = exportPlan.collectorUrl;
      if (isLangfuseCentralMediaUploadDisabled()) {
        langfuse.mediaUploadEnabled = false;
      }
      break;
    case 'disabled':
      langfuse.enabled = false;
      break;
    case 'directCentral':
      applyCentralEnvConfig(langfuse);
      break;
  }

  return applyCustomHeaders(langfuse, additionalHeaders);
}
