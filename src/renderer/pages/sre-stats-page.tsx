import { Renderer } from "@freelensapp/extensions";
import { formatNodeTaint, type KubeEvent, type Node, type Pod } from "@freelensapp/kube-object";
import { observer } from "mobx-react";
import React, { useEffect, useMemo } from "react";
import { ErrorPage } from "../components/error-page";
import styles from "./sre-stats-page.module.scss";
import stylesInline from "./sre-stats-page.module.scss?inline";

const {
  K8sApi: { nodesStore, podsStore, eventStore, namespaceStore },
} = Renderer;

export interface SreStatsPageProps {
  extension: Renderer.LensExtension;
}

interface TaintSummaryItem {
  taint: string;
  nodes: number;
  occurrences: number;
}

interface NamespacePodStats {
  namespace: string;
  running: number;
  pending: number;
  failed: number;
  succeeded: number;
  unknown: number;
  issues: number;
  restarts: number;
  warningEvents: number;
  issueScore: number;
  total: number;
}

function getNodeStatus(node: Node): "Ready" | "NotReady" | "SchedulingDisabled" | "Unknown" {
  if (node.isUnschedulable()) {
    return "SchedulingDisabled";
  }

  const readyCondition = node.getConditions().find((condition) => condition.type === "Ready");

  if (!readyCondition) {
    return "Unknown";
  }

  return readyCondition.status === "True" ? "Ready" : "NotReady";
}

function getPodPhase(pod: Pod): "Running" | "Pending" | "Failed" | "Succeeded" | "Unknown" {
  const phase = pod.getStatusPhase();

  switch (phase) {
    case "Running":
    case "Pending":
    case "Failed":
    case "Succeeded":
      return phase;
    default:
      return "Unknown";
  }
}

function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>{label}</div>
      <div className={styles.cardValue}>{value}</div>
      {hint ? <div className={styles.cardHint}>{hint}</div> : null}
    </div>
  );
}

function buildTaintSummary(nodes: Node[]): TaintSummaryItem[] {
  const taintSummary = new Map<string, { nodes: Set<string>; occurrences: number }>();

  for (const node of nodes) {
    for (const taint of node.getTaints()) {
      const taintLabel = formatNodeTaint(taint);
      const entry = taintSummary.get(taintLabel) ?? { nodes: new Set<string>(), occurrences: 0 };

      entry.nodes.add(node.getName());
      entry.occurrences += 1;
      taintSummary.set(taintLabel, entry);
    }
  }

  return Array.from(taintSummary.entries())
    .map(([taint, data]) => ({ taint, nodes: data.nodes.size, occurrences: data.occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

function buildWarningEventsByNamespace(events: KubeEvent[]) {
  const warnings = new Map<string, number>();

  for (const event of events) {
    if (!event.isWarning()) {
      continue;
    }

    const namespace = event.getNs() ?? event.involvedObject?.namespace ?? "<cluster>";
    const count = event.count ?? 1;

    warnings.set(namespace, (warnings.get(namespace) ?? 0) + count);
  }

  return warnings;
}

function buildNamespacePodStats(pods: Pod[], warningEventsByNamespace: Map<string, number>): NamespacePodStats[] {
  const stats = new Map<string, NamespacePodStats>();

  for (const pod of pods) {
    const namespace = pod.getNs() ?? "<unknown>";
    const entry = stats.get(namespace) ?? {
      namespace,
      running: 0,
      pending: 0,
      failed: 0,
      succeeded: 0,
      unknown: 0,
      issues: 0,
      restarts: 0,
      warningEvents: warningEventsByNamespace.get(namespace) ?? 0,
      issueScore: 0,
      total: 0,
    };

    const phase = getPodPhase(pod);

    entry.total += 1;

    switch (phase) {
      case "Running":
        entry.running += 1;
        break;
      case "Pending":
        entry.pending += 1;
        break;
      case "Failed":
        entry.failed += 1;
        break;
      case "Succeeded":
        entry.succeeded += 1;
        break;
      case "Unknown":
      default:
        entry.unknown += 1;
        break;
    }

    if (pod.hasIssues()) {
      entry.issues += 1;
    }

    entry.restarts += pod.getRestartsCount();

    stats.set(namespace, entry);
  }

  for (const entry of Array.from(stats.values())) {
    entry.warningEvents = warningEventsByNamespace.get(entry.namespace) ?? 0;
    entry.issueScore = entry.issues + entry.restarts + entry.warningEvents;
  }

  return Array.from(stats.values()).sort((a, b) => b.issues - a.issues || b.total - a.total);
}

function buildWarningReasons(events: KubeEvent[]) {
  const reasons = new Map<string, number>();

  for (const event of events) {
    if (!event.isWarning()) {
      continue;
    }

    const reason = event.reason ?? "<unknown>";
    const count = event.count ?? 1;

    reasons.set(reason, (reasons.get(reason) ?? 0) + count);
  }

  return Array.from(reasons.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

export const SreStatsPage = observer((props: SreStatsPageProps) => {
  useEffect(() => {
    const disposers = [
      namespaceStore.subscribe(),
      nodesStore.subscribe(),
      podsStore.subscribe(),
      eventStore.subscribe(),
    ];

    nodesStore.loadAll();
    namespaceStore.loadAll();

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, []);

  const allNamespaces = namespaceStore.items.map((namespace) => namespace.getName());

  useEffect(() => {
    const namespaces = allNamespaces;
    const onLoadFailure = (error: unknown) => {
      console.warn("[SRE-STATS] Namespace load failed", error);
    };

    if (namespaces.length > 0) {
      console.info("[SRE-STATS] Loading pods/events for namespaces", namespaces.length);
      podsStore.loadAll({ namespaces, onLoadFailure });
      eventStore.loadAll({ namespaces, onLoadFailure });
    } else {
      console.info("[SRE-STATS] No namespaces available, falling back to current context");
      podsStore.loadAll({ onLoadFailure });
      eventStore.loadAll({ onLoadFailure });
    }
  }, [allNamespaces.join("|")]);

  const nodes = nodesStore.items;
  const pods = podsStore.items;
  const events = eventStore.items;

  const nodeStatusCounts = useMemo(() => {
    const summary = {
      total: nodes.length,
      ready: 0,
      notReady: 0,
      schedulingDisabled: 0,
      unknown: 0,
      warningConditions: 0,
    };

    for (const node of nodes) {
      switch (getNodeStatus(node)) {
        case "Ready":
          summary.ready += 1;
          break;
        case "NotReady":
          summary.notReady += 1;
          break;
        case "SchedulingDisabled":
          summary.schedulingDisabled += 1;
          break;
        case "Unknown":
        default:
          summary.unknown += 1;
          break;
      }

      summary.warningConditions += node.getWarningConditions().length;
    }

    return summary;
  }, [nodes]);

  const taintSummary = useMemo(() => buildTaintSummary(nodes), [nodes]);
  const warningEventsByNamespace = useMemo(() => buildWarningEventsByNamespace(events), [events]);
  const namespaceStats = useMemo(
    () => buildNamespacePodStats(pods, warningEventsByNamespace),
    [pods, warningEventsByNamespace],
  );
  const warningReasons = useMemo(() => buildWarningReasons(events), [events]);

  const topNamespaces = useMemo(() => {
    return [...namespaceStats]
      .filter((entry) => entry.issueScore > 0)
      .sort((a, b) => b.issueScore - a.issueScore)
      .slice(0, 8);
  }, [namespaceStats]);

  const heatmapEntries = useMemo(() => {
    const maxScore = Math.max(0, ...namespaceStats.map((entry) => entry.issueScore));

    return namespaceStats.map((entry) => {
      const ratio = maxScore === 0 ? 0 : entry.issueScore / maxScore;
      const intensity = ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : ratio > 0 ? 1 : 0;

      return {
        ...entry,
        intensity,
      };
    });
  }, [namespaceStats]);

  const eventSummary = useMemo(() => {
    let warnings = 0;
    let normals = 0;
    let others = 0;

    for (const event of events) {
      const count = event.count ?? 1;

      if (event.isWarning()) {
        warnings += count;
      } else if (event.type === "Normal") {
        normals += count;
      } else {
        others += count;
      }
    }

    return { warnings, normals, others, total: warnings + normals + others };
  }, [events]);

  try {
    return (
      <>
        <style>{stylesInline}</style>
        <div className={styles.page}>
          <header className={styles.header}>
            <div>
              <div className={styles.title}>SRE Stats</div>
              <div className={styles.subtitle}>Cluster investigation summary for nodes, pods, and events.</div>
            </div>
          </header>

          <section className={styles.section}>
            <h3>Node status</h3>
            <div className={styles.cards}>
              <StatCard label="Total nodes" value={nodeStatusCounts.total} />
              <StatCard label="Ready" value={nodeStatusCounts.ready} />
              <StatCard label="Not ready" value={nodeStatusCounts.notReady} />
              <StatCard label="Scheduling disabled" value={nodeStatusCounts.schedulingDisabled} />
              <StatCard label="Unknown" value={nodeStatusCounts.unknown} />
              <StatCard label="Warning conditions" value={nodeStatusCounts.warningConditions} />
            </div>
          </section>

          <section className={styles.section}>
            <h3>Node taints repartition</h3>
            {taintSummary.length === 0 ? (
              <div className={styles.empty}>No taints detected.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Taint</th>
                    <th>Nodes</th>
                    <th>Occurrences</th>
                  </tr>
                </thead>
                <tbody>
                  {taintSummary.map((item) => (
                    <tr key={item.taint}>
                      <td>{item.taint}</td>
                      <td>{item.nodes}</td>
                      <td>{item.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={styles.section}>
            <h3>Pod status by namespace</h3>
            {namespaceStats.length === 0 ? (
              <div className={styles.empty}>No pods detected in the selected namespaces.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Namespace</th>
                    <th>Total</th>
                    <th>Running</th>
                    <th>Pending</th>
                    <th>Failed</th>
                    <th>Succeeded</th>
                    <th>Unknown</th>
                    <th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {namespaceStats.map((entry) => (
                    <tr key={entry.namespace}>
                      <td>{entry.namespace}</td>
                      <td>{entry.total}</td>
                      <td>{entry.running}</td>
                      <td>{entry.pending}</td>
                      <td>{entry.failed}</td>
                      <td>{entry.succeeded}</td>
                      <td>{entry.unknown}</td>
                      <td className={entry.issues ? styles.issuesCell : undefined}>{entry.issues}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={styles.section}>
            <h3>Namespace heatmap (issues + restarts + warning events)</h3>
            {heatmapEntries.length === 0 ? (
              <div className={styles.empty}>No namespaces detected.</div>
            ) : (
              <div className={styles.heatmap}>
                {heatmapEntries.map((entry) => (
                  <div
                    key={entry.namespace}
                    className={`${styles.heatmapCell} ${styles[`heat${entry.intensity}`]}`}
                    title={`Issues ${entry.issues} · Restarts ${entry.restarts} · Warnings ${entry.warningEvents}`}
                  >
                    <div className={styles.heatmapName}>{entry.namespace}</div>
                    <div className={styles.heatmapScore}>{entry.issueScore}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h3>Top namespaces with issues</h3>
            {topNamespaces.length === 0 ? (
              <div className={styles.empty}>No issues detected.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Namespace</th>
                    <th>Pod issues</th>
                    <th>Restarts</th>
                    <th>Warning events</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {topNamespaces.map((entry) => (
                    <tr key={entry.namespace}>
                      <td>{entry.namespace}</td>
                      <td>{entry.issues}</td>
                      <td>{entry.restarts}</td>
                      <td>{entry.warningEvents}</td>
                      <td className={styles.scoreCell}>{entry.issueScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={styles.section}>
            <h3>Events summary</h3>
            <div className={styles.cards}>
              <StatCard label="Total events" value={eventSummary.total} />
              <StatCard label="Warnings" value={eventSummary.warnings} />
              <StatCard label="Normal" value={eventSummary.normals} />
              <StatCard label="Other" value={eventSummary.others} />
            </div>

            {warningReasons.length === 0 ? (
              <div className={styles.empty}>No warning events detected.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Warning reason</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {warningReasons.slice(0, 10).map((reason) => (
                    <tr key={reason.reason}>
                      <td>{reason.reason}</td>
                      <td>{reason.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </>
    );
  } catch (error) {
    return <ErrorPage error={error} extension={props.extension} />;
  }
});
