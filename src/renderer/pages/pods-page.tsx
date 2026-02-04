import { Renderer } from "@freelensapp/extensions";
import { type KubeEvent, type Pod } from "@freelensapp/kube-object";
import { observer } from "mobx-react";
import { useEffect, useMemo, useState } from "react";
import { ErrorPage } from "../components/error-page";
import styles from "./sre-stats-page.module.scss";
import stylesInline from "./sre-stats-page.module.scss?inline";

const {
  K8sApi: { podsStore, eventStore, namespaceStore },
} = Renderer;

export interface PodsPageProps {
  extension: Renderer.LensExtension;
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

interface RestartInfo {
  reasons: Map<string, number>;
  total: number;
}

function getRestartInfo(pod: Pod): RestartInfo {
  const containerStatuses = pod.getContainerStatuses();
  const reasons = new Map<string, number>();
  let total = 0;

  for (const status of containerStatuses) {
    total += status.restartCount;

    if (status.restartCount > 0 && status.lastState?.terminated) {
      const reason = status.lastState.terminated.reason || "Unknown";
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }

  return { reasons, total };
}

function getIssueDetails(pod: Pod): string[] {
  const issues: string[] = [];
  const containerStatuses = pod.getContainerStatuses();
  const isJobPod = pod.getOwnerRefs()?.some((ref) => ref.kind === "Job");

  // Check container states
  for (const status of containerStatuses) {
    if (status.state?.waiting) {
      const reason = status.state.waiting.reason || "Unknown";
      const message = status.state.waiting.message;
      issues.push(`${status.name}: ${reason}${message ? ` - ${message}` : ""}`);
    } else if (status.state?.terminated) {
      const reason = status.state.terminated.reason || "Unknown";
      const exitCode = status.state.terminated.exitCode;
      // Show terminated as issue if exit code is not 0 OR if it's a job pod with exit code 0
      if (exitCode !== 0) {
        issues.push(`${status.name}: ${reason} (exit: ${exitCode})`);
      } else if (isJobPod && exitCode === 0) {
        issues.push(`${status.name}: Job completed (exit: ${exitCode})`);
      }
    } else if (!status.ready && status.state?.running) {
      issues.push(`${status.name}: Not ready`);
    }
  }

  // Check pod conditions
  const conditions = pod.getConditions();
  for (const condition of conditions) {
    if (condition.status !== "True" && condition.reason && condition.reason !== "PodCompleted") {
      const message = condition.message || condition.reason;
      issues.push(`${condition.type}: ${message}`);
    }
  }

  return issues;
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

export const PodsPage = observer((props: PodsPageProps) => {
  const [expandedNamespaces, setExpandedNamespaces] = useState<Set<string>>(new Set());
  const [showOnlyIssues, setShowOnlyIssues] = useState(true);

  const toggleNamespace = (namespace: string) => {
    setExpandedNamespaces((prev) => {
      const next = new Set(prev);
      if (next.has(namespace)) {
        next.delete(namespace);
      } else {
        next.add(namespace);
      }
      return next;
    });
  };

  const scrollToNamespace = (namespace: string) => {
    const row = document.getElementById(`namespace-${namespace}`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      setExpandedNamespaces((prev) => new Set(prev).add(namespace));
    }
  };

  useEffect(() => {
    const disposers = [namespaceStore.subscribe(), podsStore.subscribe(), eventStore.subscribe()];

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

  const pods = podsStore.items;
  const events = eventStore.items;

  const warningEventsByNamespace = useMemo(() => buildWarningEventsByNamespace(events), [events]);
  const namespaceStats = useMemo(
    () => buildNamespacePodStats(pods, warningEventsByNamespace),
    [pods, warningEventsByNamespace],
  );

  const filteredNamespaceStats = useMemo(() => {
    if (!showOnlyIssues) {
      return namespaceStats;
    }
    return namespaceStats.filter((entry) => entry.issueScore > 0);
  }, [namespaceStats, showOnlyIssues]);

  const topNamespaces = useMemo(() => {
    return [...namespaceStats]
      .filter((entry) => entry.issueScore > 0)
      .sort((a, b) => b.issueScore - a.issueScore)
      .slice(0, 10);
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

  const filteredHeatmapEntries = useMemo(() => {
    if (!showOnlyIssues) {
      return heatmapEntries;
    }
    return heatmapEntries.filter((entry) => entry.issueScore > 0);
  }, [heatmapEntries, showOnlyIssues]);

  try {
    return (
      <>
        <style>{stylesInline}</style>
        <div className={styles.page}>
          <header className={styles.header}>
            <div>
              <div className={styles.title}>Pods Analysis</div>
              <div className={styles.subtitle}>Pod status and issues grouped by namespace.</div>
            </div>
          </header>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>Namespace Heatmap (Issues + Restarts + Warning Events)</h3>
              <label className={styles.filterToggle}>
                <input type="checkbox" checked={showOnlyIssues} onChange={(e) => setShowOnlyIssues(e.target.checked)} />
                <span>Show only issues</span>
              </label>
            </div>
            {filteredHeatmapEntries.length === 0 ? (
              <div className={styles.empty}>
                {showOnlyIssues
                  ? "No namespaces with issues detected. Toggle the filter to see all."
                  : "No namespaces detected."}
              </div>
            ) : (
              <div className={styles.heatmap}>
                {filteredHeatmapEntries.map((entry) => (
                  <div
                    key={entry.namespace}
                    className={`${styles.heatmapCell} ${styles[`heat${entry.intensity}`]}`}
                    title={`Issues ${entry.issues} · Restarts ${entry.restarts} · Warnings ${entry.warningEvents} (click to view)`}
                    onClick={() => scrollToNamespace(entry.namespace)}
                    style={{ cursor: "pointer" }}
                  >
                    <div className={styles.heatmapName}>{entry.namespace}</div>
                    <div className={styles.heatmapScore}>{entry.issueScore}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>Pod Status by Namespace</h3>
            </div>
            {filteredNamespaceStats.length === 0 ? (
              <div className={styles.empty}>
                {showOnlyIssues
                  ? "No namespaces with issues detected. Toggle the filter to see all."
                  : "No pods detected in the selected namespaces."}
              </div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th style={{ width: "40px" }}></th>
                    <th>Namespace</th>
                    <th>Total</th>
                    <th>Running</th>
                    <th>Pending</th>
                    <th>Failed</th>
                    <th>Succeeded</th>
                    <th>Unknown</th>
                    <th>Issues</th>
                    <th>Restarts</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNamespaceStats.map((entry) => {
                    const isExpanded = expandedNamespaces.has(entry.namespace);
                    const namespacePods = pods.filter((pod) => pod.getNs() === entry.namespace);

                    return (
                      <>
                        <tr
                          key={entry.namespace}
                          id={`namespace-${entry.namespace}`}
                          className={styles.namespaceRow}
                          onClick={() => toggleNamespace(entry.namespace)}
                          style={{ cursor: "pointer" }}
                        >
                          <td style={{ textAlign: "center" }}>
                            <span className={styles.expandIcon}>{isExpanded ? "▼" : "▶"}</span>
                          </td>
                          <td className={styles.namespaceCell}>{entry.namespace}</td>
                          <td>{entry.total}</td>
                          <td>
                            {entry.running > 0 && (
                              <span
                                className={styles.statusBadge}
                                style={{ background: "rgba(76, 175, 80, 0.2)", color: "rgb(76, 175, 80)" }}
                              >
                                ✓ {entry.running}
                              </span>
                            )}
                          </td>
                          <td>
                            {entry.pending > 0 && (
                              <span
                                className={styles.statusBadge}
                                style={{ background: "rgba(255, 193, 7, 0.2)", color: "rgb(255, 193, 7)" }}
                              >
                                ⏳ {entry.pending}
                              </span>
                            )}
                          </td>
                          <td>
                            {entry.failed > 0 && (
                              <span
                                className={styles.statusBadge}
                                style={{ background: "rgba(244, 67, 54, 0.2)", color: "rgb(244, 67, 54)" }}
                              >
                                ✗ {entry.failed}
                              </span>
                            )}
                          </td>
                          <td>
                            {entry.succeeded > 0 && (
                              <span
                                className={styles.statusBadge}
                                style={{ background: "rgba(33, 150, 243, 0.2)", color: "rgb(33, 150, 243)" }}
                              >
                                ✓ {entry.succeeded}
                              </span>
                            )}
                          </td>
                          <td>
                            {entry.unknown > 0 && (
                              <span
                                className={styles.statusBadge}
                                style={{ background: "rgba(158, 158, 158, 0.2)", color: "rgb(158, 158, 158)" }}
                              >
                                ? {entry.unknown}
                              </span>
                            )}
                          </td>
                          <td className={entry.issues ? styles.issuesCell : undefined}>
                            {entry.issues > 0 && `⚠️ ${entry.issues}`}
                          </td>
                          <td className={entry.restarts > 0 ? styles.issuesCell : undefined}>
                            {entry.restarts > 0 && `🔄 ${entry.restarts}`}
                          </td>
                        </tr>
                        {isExpanded &&
                          (() => {
                            // Filter pods based on showOnlyIssues setting
                            const filteredPods = showOnlyIssues
                              ? namespacePods.filter((pod) => {
                                  const hasIssues = pod.hasIssues();
                                  const restarts = pod.getRestartsCount();
                                  const issueDetails = getIssueDetails(pod);
                                  return hasIssues || restarts > 0 || issueDetails.length > 0;
                                })
                              : namespacePods;

                            return (
                              <tr key={`${entry.namespace}-details`}>
                                <td colSpan={10} className={styles.expandedCell}>
                                  <div className={styles.podDetails}>
                                    <div className={styles.podDetailsHeader}>
                                      Pods in {entry.namespace}
                                      {showOnlyIssues && filteredPods.length < namespacePods.length && (
                                        <span className={styles.filteredInfo}>
                                          {" "}
                                          ({filteredPods.length} of {namespacePods.length} pods with issues)
                                        </span>
                                      )}
                                    </div>
                                    {filteredPods.length === 0 ? (
                                      <div className={styles.empty}>No pods with issues in this namespace.</div>
                                    ) : (
                                      <table className={styles.podTable}>
                                        <thead>
                                          <tr>
                                            <th>Pod Name</th>
                                            <th>Status</th>
                                            <th>Restarts</th>
                                            <th>Restart Reasons</th>
                                            <th>Age</th>
                                            <th>Issue Details</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {filteredPods.map((pod) => {
                                            const phase = getPodPhase(pod);
                                            const hasIssues = pod.hasIssues();
                                            const restarts = pod.getRestartsCount();
                                            const age = pod.getAge();
                                            const restartInfo = getRestartInfo(pod);
                                            const issueDetails = getIssueDetails(pod);

                                            return (
                                              <tr
                                                key={pod.getId()}
                                                className={hasIssues ? styles.podWithIssues : undefined}
                                              >
                                                <td className={styles.podName}>{pod.getName()}</td>
                                                <td>
                                                  {phase === "Running" && (
                                                    <span
                                                      className={styles.statusBadge}
                                                      style={{
                                                        background: "rgba(76, 175, 80, 0.2)",
                                                        color: "rgb(76, 175, 80)",
                                                      }}
                                                    >
                                                      ✓ Running
                                                    </span>
                                                  )}
                                                  {phase === "Pending" && (
                                                    <span
                                                      className={styles.statusBadge}
                                                      style={{
                                                        background: "rgba(255, 193, 7, 0.2)",
                                                        color: "rgb(255, 193, 7)",
                                                      }}
                                                    >
                                                      ⏳ Pending
                                                    </span>
                                                  )}
                                                  {phase === "Failed" && (
                                                    <span
                                                      className={styles.statusBadge}
                                                      style={{
                                                        background: "rgba(244, 67, 54, 0.2)",
                                                        color: "rgb(244, 67, 54)",
                                                      }}
                                                    >
                                                      ✗ Failed
                                                    </span>
                                                  )}
                                                  {phase === "Succeeded" && (
                                                    <span
                                                      className={styles.statusBadge}
                                                      style={{
                                                        background: "rgba(33, 150, 243, 0.2)",
                                                        color: "rgb(33, 150, 243)",
                                                      }}
                                                    >
                                                      ✓ Succeeded
                                                    </span>
                                                  )}
                                                  {phase === "Unknown" && (
                                                    <span
                                                      className={styles.statusBadge}
                                                      style={{
                                                        background: "rgba(158, 158, 158, 0.2)",
                                                        color: "rgb(158, 158, 158)",
                                                      }}
                                                    >
                                                      ? Unknown
                                                    </span>
                                                  )}
                                                </td>
                                                <td className={restarts > 0 ? styles.issuesCell : undefined}>
                                                  {restarts > 0 ? `🔄 ${restarts}` : restarts}
                                                </td>
                                                <td className={styles.restartReasons}>
                                                  {restartInfo.reasons.size > 0 ? (
                                                    <div className={styles.reasonsList}>
                                                      {Array.from(restartInfo.reasons.entries()).map(
                                                        ([reason, count]) => (
                                                          <div key={reason} className={styles.reasonItem}>
                                                            <span className={styles.reasonBadge}>{reason}</span>
                                                            {count > 1 && (
                                                              <span className={styles.reasonCount}>×{count}</span>
                                                            )}
                                                          </div>
                                                        ),
                                                      )}
                                                    </div>
                                                  ) : (
                                                    <span className={styles.noData}>-</span>
                                                  )}
                                                </td>
                                                <td className={styles.ageCell}>{age}</td>
                                                <td className={styles.issueDetails}>
                                                  {issueDetails.length > 0 ? (
                                                    <div className={styles.issuesList}>
                                                      {issueDetails.map((issue, idx) => (
                                                        <div key={idx} className={styles.issueItem}>
                                                          {issue}
                                                        </div>
                                                      ))}
                                                    </div>
                                                  ) : hasIssues ? (
                                                    <span className={styles.issuesBadge}>⚠️ Check pod</span>
                                                  ) : (
                                                    <span className={styles.noData}>-</span>
                                                  )}
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })()}
                      </>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className={styles.section}>
            <h3>Top Namespaces with Issues</h3>
            {topNamespaces.length === 0 ? (
              <div className={styles.empty}>No issues detected.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Namespace</th>
                    <th>Pod Issues</th>
                    <th>Restarts</th>
                    <th>Warning Events</th>
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
        </div>
      </>
    );
  } catch (error) {
    return <ErrorPage error={error} extension={props.extension} />;
  }
});
