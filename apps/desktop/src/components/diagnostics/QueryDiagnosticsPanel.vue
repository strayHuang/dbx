<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CheckCircle2, Copy, Gauge, Info, Loader2, RefreshCw, Snowflake, Sun } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { QueryDiagnosis, QueryDiagnosticFinding } from "@/lib/diagnostics/queryDiagnostics";

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

const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };

const findings = computed<QueryDiagnosticFinding[]>(() => [...(props.diagnosis?.findings ?? [])].sort((left, right) => (severityOrder[left.severity] ?? 9) - (severityOrder[right.severity] ?? 9)));

const metrics = computed(() => props.diagnosis?.metrics ?? {});

const severityIcon = (severity: string) => (severity === "critical" ? AlertTriangle : severity === "warning" ? AlertTriangle : Info);

const severityClass = (severity: string) => (severity === "critical" ? "text-destructive" : severity === "warning" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground");

const measuredRows = computed(() => props.diagnosis?.measured ?? []);

const copyText = (value: string) => void navigator.clipboard?.writeText(value);
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
            <span>{{ suggestion.reason }}</span>
            <span v-if="suggestion.impact !== undefined">（{{ suggestion.impact }}%）</span>
            <Button size="sm" variant="ghost" class="ml-auto h-5 px-1.5 text-[10px]" @click="copyText(suggestion.sql)"> <Copy class="mr-1 h-3 w-3" />{{ t("diagnostics.copy") }} </Button>
          </div>
          <pre class="overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">{{ suggestion.sql }}</pre>
        </div>
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
