<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Ban, CheckCircle2, Clock, Copy, FlaskConical, Gauge, Info, Loader2, Package, RefreshCw, Snowflake, Sun } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryDiagnosis, QueryDiagnosticFinding, QueryIndexSuggestion } from "@/lib/diagnostics/queryDiagnostics";
import type { HypopgTrial } from "@/lib/diagnostics/hypopgSupport";
import { estimateElapsedMs, formatPlanCost, pickBestHypopgTrial } from "@/lib/diagnostics/hypopgSupport";

const props = withDefaults(
  defineProps<{
    diagnosis?: QueryDiagnosis;
    error?: string;
    loading?: boolean;
    sourceSql?: string;
    canDiagnose?: boolean;
  }>(),
  { canDiagnose: true },
);

const emit = defineEmits<{ diagnose: [] }>();

const { t } = useI18n();
const settingsStore = useSettingsStore();

const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };

const findings = computed<QueryDiagnosticFinding[]>(() => [...(props.diagnosis?.findings ?? [])].sort((left, right) => (severityOrder[left.severity] ?? 9) - (severityOrder[right.severity] ?? 9)));

const metrics = computed(() => props.diagnosis?.metrics ?? {});

const severityIcon = (severity: string) => (severity === "critical" ? AlertTriangle : severity === "warning" ? AlertTriangle : Info);

const severityClass = (severity: string) => (severity === "critical" ? "text-destructive" : severity === "warning" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground");

const measuredRows = computed(() => props.diagnosis?.measured ?? []);

const copyText = (value: string) => void navigator.clipboard?.writeText(value);

/** 本次诊断里用户点了“稍候安装”后的临时隐藏；重新诊断会再次提示。 */
const hypopgDismissed = ref(false);
watch(
  () => props.diagnosis,
  () => {
    hypopgDismissed.value = false;
  },
);

const hypopg = computed(() => props.diagnosis?.hypopg);

/** 服务器没装 hypopg：展示安装命令与“稍候 / 永不安装”。 */
const showHypopgSetup = computed(() => {
  const info = hypopg.value;
  if (!info || info.promptSuppressed || hypopgDismissed.value) return false;
  if (info.availability === "installed" || info.availability === "unknown") return false;
  return info.installHint !== undefined;
});

/** 已装 hypopg：展示假设索引试算结果。 */
const showHypopgTrials = computed(() => {
  const info = hypopg.value;
  if (!info || info.availability !== "installed" || hypopgDismissed.value) return false;
  return (info.trials?.length ?? 0) > 0;
});

const hypopgSetupText = computed(() => {
  const hint = hypopg.value?.installHint;
  if (!hint) return "";
  return [...hint.shellCommands, ...(hint.shellCommands.length > 0 ? [""] : []), ...hint.sqlStatements].join("\n");
});

/** 文件已装、只差 CREATE EXTENSION 时，标题不能写“未安装”。 */
const hypopgSetupTitle = computed(() => (hypopg.value?.availability === "available" ? t("diagnostics.hypopgAvailableTitle") : t("diagnostics.hypopgMissingTitle")));

const hypopgSetupDetail = computed(() => hypopg.value?.note ?? (hypopg.value?.availability === "available" ? t("diagnostics.hypopgAvailableNotCreated") : t("diagnostics.hypopgMissingDetail")));

const decideHypopg = (decision: "later" | "never") => {
  const serverKey = hypopg.value?.serverKey;
  if (serverKey) settingsStore.rememberHypopgInstallDecision(serverKey, decision);
  hypopgDismissed.value = true;
};

const hypopgTrialVerdict = (trial: HypopgTrial) => (trial.used ? t("diagnostics.hypopgSelected") : t("diagnostics.hypopgNotSelected"));

/** 现状基线：所有试算都拿它作对照，成本列才能读成“比现在省多少”。 */
const hypopgBaseCost = computed(() => hypopg.value?.baseCost ?? hypopg.value?.trials?.find((trial) => trial.baseCost !== undefined)?.baseCost);

const hypopgBaseElapsedMs = computed(() => props.diagnosis?.metrics.elapsedMs);

/** 成本最低且没有报错的试算组合；规划器成本是相对单位，只能横向比较。 */
const hypopgBestTrial = computed<HypopgTrial | undefined>(() => pickBestHypopgTrial(hypopg.value?.trials ?? []));

/** 按成本从低到高排列，最优点在第一屏；失败的试算排最后。 */
const hypopgTrials = computed(() =>
  [...(hypopg.value?.trials ?? [])].sort((left, right) => {
    const leftCost = left.error || left.hypotheticalCost === undefined ? Number.POSITIVE_INFINITY : left.hypotheticalCost;
    const rightCost = right.error || right.hypotheticalCost === undefined ? Number.POSITIVE_INFINITY : right.hypotheticalCost;
    return leftCost - rightCost || left.candidateRefs.length - right.candidateRefs.length;
  }),
);

const deltaText = (pct?: number) => {
  if (pct === undefined || !Number.isFinite(pct)) return "-";
  if (Math.abs(pct) < 0.05) return t("diagnostics.hypopgDeltaSame");
  return pct < 0 ? t("diagnostics.hypopgDeltaLower", { value: Math.abs(pct).toFixed(1) }) : t("diagnostics.hypopgDeltaHigher", { value: pct.toFixed(1) });
};

const deltaClass = (pct?: number) => {
  if (pct === undefined) return "text-muted-foreground";
  if (pct < -0.05) return "font-medium text-emerald-600 dark:text-emerald-400";
  if (pct > 0.05) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
};

/** 成本折算出的粗估耗时；没有实测基线时不显示，避免编造数字。 */
const trialElapsed = (trial: HypopgTrial) => estimateElapsedMs(trial.hypotheticalCost, hypopgBaseCost.value, hypopgBaseElapsedMs.value);

const trialElapsedText = (trial: HypopgTrial) => {
  const elapsed = trialElapsed(trial);
  return elapsed === undefined ? "-" : `${elapsed >= 100 ? Math.round(elapsed) : Math.round(elapsed * 10) / 10} ms`;
};

const trialTooltip = (trial: HypopgTrial) => trial.indexSqls.join("\n");

/** `#编号 表 (键列) INCLUDE … WHERE …`，不用悬停也能看懂这行试算的是哪几条索引。 */
const suggestionSummary = (suggestion: QueryIndexSuggestion) => {
  const include = suggestion.includeColumns.length > 0 ? ` INCLUDE (${suggestion.includeColumns.join(", ")})` : "";
  const where = suggestion.where ? ` WHERE ${suggestion.where}` : "";
  return `${suggestion.table} (${suggestion.columns.join(", ")})${include}${where}`;
};

const trialDetail = (trial: HypopgTrial) =>
  trial.candidateRefs
    .map((ref) => {
      const suggestion = props.diagnosis?.indexSuggestions[ref - 1];
      return suggestion ? `#${ref} ${suggestionSummary(suggestion)}` : `#${ref}`;
    })
    .join("；");

const hypopgBestText = computed(() => {
  const best = hypopgBestTrial.value;
  if (!best) return "";
  return t("diagnostics.hypopgBest", { title: best.title, delta: deltaText(best.costDeltaPct), count: best.candidateRefs.length });
});
</script>

<template>
  <div class="flex flex-1 min-h-0 min-w-0 flex-col overflow-auto bg-background p-3 text-xs">
    <div class="mb-3 flex shrink-0 items-center gap-2">
      <Gauge class="h-4 w-4 text-muted-foreground" />
      <span class="font-medium">{{ t("diagnostics.title") }}</span>
      <span v-if="diagnosis" class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]" :class="diagnosis.coldStart ? 'border-sky-500/40 text-sky-600 dark:text-sky-400' : 'border-amber-500/40 text-amber-600 dark:text-amber-400'" :title="diagnosis.cacheNote ?? ''">
        <Snowflake v-if="diagnosis.coldStart" class="h-3 w-3" />
        <Sun v-else class="h-3 w-3" />
        {{ diagnosis.coldStart ? t("diagnostics.coldCache") : t("diagnostics.warmCache") }}
      </span>
      <div class="ml-auto flex items-center gap-1">
        <Button size="sm" variant="ghost" class="h-6 gap-1 px-2 text-xs" :disabled="loading || !canDiagnose" @click="emit('diagnose')">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
          {{ loading ? t("diagnostics.running") : t("diagnostics.run") }}
        </Button>
      </div>
    </div>

    <div v-if="error" class="mb-3 rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">{{ error }}</div>

    <div v-if="loading" class="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("diagnostics.runningHint") }}
    </div>

    <div v-else-if="!diagnosis" class="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
      <Gauge class="h-6 w-6" />
      <span>{{ t("diagnostics.empty") }}</span>
      <Button size="sm" variant="secondary" class="h-7 px-3 text-xs" :disabled="!canDiagnose" @click="emit('diagnose')">{{ t("diagnostics.run") }}</Button>
    </div>

    <template v-else>
      <div class="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <div v-if="metrics.elapsedMs !== undefined" class="rounded border p-2">
          <div class="text-[10px] text-muted-foreground">{{ t("diagnostics.elapsedMs") }}</div>
          <div class="text-sm font-medium">{{ metrics.elapsedMs.toFixed(1) }}</div>
        </div>
        <div v-if="metrics.cpuMs !== undefined" class="rounded border p-2">
          <div class="text-[10px] text-muted-foreground">{{ t("diagnostics.cpuMs") }}</div>
          <div class="text-sm font-medium">{{ metrics.cpuMs.toFixed(1) }}</div>
        </div>
        <div v-if="metrics.logicalReads !== undefined" class="rounded border p-2">
          <div class="text-[10px] text-muted-foreground">{{ t("diagnostics.logicalReads") }}</div>
          <div class="text-sm font-medium">{{ metrics.logicalReads }}</div>
        </div>
        <div v-if="metrics.executionTimeMs !== undefined" class="rounded border p-2">
          <div class="text-[10px] text-muted-foreground">{{ t("diagnostics.executionTime") }}</div>
          <div class="text-sm font-medium">{{ metrics.executionTimeMs.toFixed(1) }} ms</div>
        </div>
        <div v-if="metrics.planningTimeMs !== undefined" class="rounded border p-2">
          <div class="text-[10px] text-muted-foreground">{{ t("diagnostics.planningTime") }}</div>
          <div class="text-sm font-medium">{{ metrics.planningTimeMs.toFixed(1) }} ms</div>
        </div>
        <div v-if="metrics.sharedHitBlocks !== undefined" class="rounded border p-2">
          <div class="text-[10px] text-muted-foreground">{{ t("diagnostics.sharedHit") }}</div>
          <div class="text-sm font-medium">{{ metrics.sharedHitBlocks }}</div>
        </div>
        <div v-if="metrics.sharedReadBlocks !== undefined" class="rounded border p-2">
          <div class="text-[10px] text-muted-foreground">{{ t("diagnostics.sharedRead") }}</div>
          <div class="text-sm font-medium">{{ metrics.sharedReadBlocks }}</div>
        </div>
      </div>

      <div class="mb-3">
        <div class="mb-1 font-medium">{{ t("diagnostics.findings") }}</div>
        <div v-if="findings.length === 0" class="flex items-center gap-1 text-muted-foreground">
          <CheckCircle2 class="h-3.5 w-3.5" />
          {{ t("diagnostics.noFindings") }}
        </div>
        <ul v-else class="space-y-1.5">
          <li v-for="finding in findings" :key="finding.code + finding.detail" class="rounded border p-2">
            <div class="flex items-start gap-1.5">
              <component :is="severityIcon(finding.severity)" class="mt-0.5 h-3.5 w-3.5 shrink-0" :class="severityClass(finding.severity)" />
              <div class="min-w-0">
                <div class="font-medium">{{ finding.title }}</div>
                <div class="text-muted-foreground">{{ finding.detail }}</div>
                <div v-if="finding.suggestion" class="mt-0.5">{{ finding.suggestion }}</div>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <div v-if="diagnosis.indexSuggestions.length > 0" class="mb-3">
        <div class="mb-1 font-medium">{{ t("diagnostics.indexSuggestions") }}</div>
        <div v-for="(suggestion, index) in diagnosis.indexSuggestions" :key="suggestion.sql + index" class="mb-1.5 rounded border p-2">
          <div class="mb-1 flex items-center gap-2 text-muted-foreground">
            <span class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] font-medium text-foreground">#{{ index + 1 }}</span>
            <span>{{ suggestion.reason }}</span>
            <span v-if="suggestion.impact !== undefined">（{{ suggestion.impact }}%）</span>
            <Button size="sm" variant="ghost" class="ml-auto h-5 px-1.5 text-[10px]" @click="copyText(suggestion.sql)"> <Copy class="mr-1 h-3 w-3" />{{ t("diagnostics.copy") }} </Button>
          </div>
          <pre class="overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">{{ suggestion.sql }}</pre>
        </div>
      </div>

      <div v-if="showHypopgSetup && hypopg?.installHint" class="mb-3 rounded border border-sky-500/40 bg-sky-500/5 p-2">
        <div class="mb-1 flex items-center gap-1.5 font-medium">
          <Package class="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          {{ hypopgSetupTitle }}
          <span v-if="hypopg.profile?.majorVersion" class="ml-auto text-[10px] font-normal text-muted-foreground">{{ hypopg.profile.distribution }} · PostgreSQL {{ hypopg.profile.majorVersion }}</span>
        </div>
        <div class="mb-1.5 text-muted-foreground">{{ hypopgSetupDetail }}</div>
        <div v-if="hypopg.error" class="mb-1.5 break-words font-mono text-[11px] text-destructive">{{ hypopg.error }}</div>
        <div v-if="hypopg.installHint.shellCommands.length > 0" class="mb-1 text-[10px] text-muted-foreground">{{ t("diagnostics.hypopgServerSteps") }}</div>
        <pre v-if="hypopg.installHint.shellCommands.length > 0" class="mb-1.5 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">{{ hypopg.installHint.shellCommands.join("\n") }}</pre>
        <div class="mb-1 text-[10px] text-muted-foreground">{{ t("diagnostics.hypopgSqlSteps") }}</div>
        <pre class="mb-1.5 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">{{ hypopg.installHint.sqlStatements.join("\n") }}</pre>
        <div v-if="hypopg.installHint.note" class="mb-1.5 text-[10px] text-muted-foreground">{{ hypopg.installHint.note }}</div>
        <div class="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" class="h-6 gap-1 px-2 text-[11px]" @click="copyText(hypopgSetupText)"> <Copy class="h-3 w-3" />{{ t("diagnostics.copy") }} </Button>
          <Button size="sm" variant="ghost" class="h-6 gap-1 px-2 text-[11px]" @click="decideHypopg('later')"> <Clock class="h-3 w-3" />{{ t("diagnostics.hypopgLater") }} </Button>
          <Button size="sm" variant="ghost" class="h-6 gap-1 px-2 text-[11px] text-muted-foreground" @click="decideHypopg('never')"> <Ban class="h-3 w-3" />{{ t("diagnostics.hypopgNever") }} </Button>
        </div>
        <div class="mt-1 text-[10px] text-muted-foreground">{{ t("diagnostics.hypopgNeverHint") }}</div>
      </div>

      <div v-if="showHypopgTrials && hypopg" class="mb-3">
        <div class="mb-1 flex items-center gap-1.5 font-medium">
          <FlaskConical class="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          {{ t("diagnostics.hypopgTrialTitle") }}
          <span class="text-[10px] font-normal text-muted-foreground">hypopg {{ hypopg.extensionVersion }}</span>
          <span class="text-[10px] font-normal text-muted-foreground">· {{ t("diagnostics.hypopgTrialCount", { count: hypopg.trials?.length ?? 0 }) }}</span>
        </div>
        <table class="w-full border-collapse">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th class="border-b py-1 pr-2">{{ t("diagnostics.hypopgTrialColumn") }}</th>
              <th class="border-b py-1 pr-2">{{ t("diagnostics.hypopgVerdictColumn") }}</th>
              <th class="border-b py-1 pr-2">{{ t("diagnostics.hypopgCostColumn") }}</th>
              <th class="border-b py-1 pr-2">{{ t("diagnostics.hypopgDeltaColumn") }}</th>
              <th class="border-b py-1">{{ t("diagnostics.hypopgElapsedColumn") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="hypopgBaseCost !== undefined" class="text-muted-foreground">
              <td class="border-b py-1 pr-2">{{ t("diagnostics.hypopgBaselineRow") }}</td>
              <td class="border-b py-1 pr-2">-</td>
              <td class="border-b py-1 pr-2">{{ formatPlanCost(hypopgBaseCost) }}</td>
              <td class="border-b py-1 pr-2">{{ t("diagnostics.hypopgBaselineDelta") }}</td>
              <td class="border-b py-1">{{ hypopgBaseElapsedMs !== undefined ? `${hypopgBaseElapsedMs.toFixed(1)} ms` : "-" }}</td>
            </tr>
            <tr v-for="trial in hypopgTrials" :key="trial.id" :class="trial.id === hypopgBestTrial?.id ? 'bg-emerald-500/5 font-medium' : ''">
              <td class="border-b py-1 pr-2">
                <div class="break-words font-medium" :title="trialTooltip(trial)">{{ trial.title }}</div>
                <div class="break-words text-[10px] font-normal text-muted-foreground">{{ trialDetail(trial) }}</div>
                <div v-if="trial.error" class="break-words text-[10px] font-normal text-destructive">{{ trial.error }}</div>
              </td>
              <td class="border-b py-1 pr-2" :class="trial.used ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'">{{ hypopgTrialVerdict(trial) }}</td>
              <td class="border-b py-1 pr-2 font-mono">{{ trial.error ? "-" : formatPlanCost(trial.hypotheticalCost) }}</td>
              <td class="border-b py-1 pr-2" :class="deltaClass(trial.costDeltaPct)">{{ trial.error ? "-" : deltaText(trial.costDeltaPct) }}</td>
              <td class="border-b py-1 text-muted-foreground">{{ trial.error ? "-" : trialElapsedText(trial) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="hypopgBestTrial" class="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 class="h-3.5 w-3.5" />
          {{ hypopgBestText }}
        </div>
        <div class="mt-1 text-[10px] text-muted-foreground">{{ t("diagnostics.hypopgCostHint") }}</div>
        <div v-if="hypopg.note" class="mt-1 text-[10px] text-muted-foreground">{{ hypopg.note }}</div>
      </div>

      <div v-if="measuredRows.length > 1" class="mb-3">
        <div class="mb-1 font-medium">{{ t("diagnostics.comparison") }}</div>
        <table class="w-full border-collapse">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th class="border-b py-1 pr-2">{{ t("diagnostics.plan") }}</th>
              <th class="border-b py-1 pr-2">{{ t("diagnostics.elapsedMs") }}</th>
              <th class="border-b py-1">{{ t("diagnostics.logicalReads") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in measuredRows" :key="row.candidate.id" :class="row.candidate.id === diagnosis.recommended?.id ? 'bg-emerald-500/5 font-medium' : ''">
              <td class="border-b py-1 pr-2">{{ row.candidate.title }}</td>
              <td class="border-b py-1 pr-2">{{ row.elapsedMs !== undefined ? row.elapsedMs.toFixed(1) : row.executionTimeMs !== undefined ? row.executionTimeMs.toFixed(1) : "-" }}</td>
              <td class="border-b py-1">{{ row.logicalReads ?? "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="diagnosis.recommended">
        <div class="mb-1 flex items-center gap-2 font-medium">
          <CheckCircle2 class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          {{ t("diagnostics.recommended") }}：{{ diagnosis.recommended.title }}
          <Button size="sm" variant="ghost" class="ml-auto h-5 px-1.5 text-[10px]" @click="copyText(diagnosis.recommended!.sql)"> <Copy class="mr-1 h-3 w-3" />{{ t("diagnostics.copy") }} </Button>
        </div>
        <pre class="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">{{ diagnosis.recommended.sql }}</pre>
      </div>
    </template>
  </div>
</template>
