import { Renderer } from "@freelensapp/extensions";
import { formatNodeTaint, type Node } from "@freelensapp/kube-object";
import { observer } from "mobx-react";
import React, { useEffect, useMemo, useState } from "react";
import { ErrorPage } from "../components/error-page";
import styles from "./sre-stats-page.module.scss";
import stylesInline from "./sre-stats-page.module.scss?inline";

const {
  K8sApi: { nodesStore, podsStore },
} = Renderer;

export interface NodesPageProps {
  extension: Renderer.LensExtension;
}

interface TaintSummaryItem {
  taint: string;
  nodes: number;
  occurrences: number;
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

function formatTaintShort(taintStr: string): string {
  // Format: intent=xxx:NoSchedule -> display only xxx
  const match = taintStr.match(/^intent=([^:]+):NoSchedule$/);
  if (match) {
    return match[1];
  }
  return taintStr;
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

type SortColumn = "name" | "status" | "pods" | "cpu" | "memory" | "issues" | "taints";
type SortDirection = "asc" | "desc";

export const NodesPage = observer((props: NodesPageProps) => {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [showOnlyProblems, setShowOnlyProblems] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  useEffect(() => {
    const disposers = [nodesStore.subscribe(), podsStore.subscribe()];

    nodesStore.loadAll();
    podsStore.loadAll();

    return () => {
      for (const disposer of disposers) {
        disposer();
      }
    };
  }, []);

  const nodes = nodesStore.items;
  const pods = podsStore.items;

  const toggleNodeExpanded = (nodeName: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeName)) {
      newExpanded.delete(nodeName);
    } else {
      newExpanded.add(nodeName);
    }
    setExpandedNodes(newExpanded);
  };

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const getNodeTaintsFormatted = (node: Node): string => {
    const taints = node.getTaints();
    if (taints.length === 0) return "-";
    return taints.map((taint) => formatTaintShort(formatNodeTaint(taint))).join(", ");
  };

  const getNodeIssues = (node: Node) => {
    const issues: string[] = [];
    const status = getNodeStatus(node);

    if (status === "NotReady") issues.push("Node is not ready");
    if (status === "SchedulingDisabled") issues.push("Scheduling is disabled");

    const conditions = node.getConditions();
    for (const condition of conditions) {
      if (condition.type !== "Ready" && condition.status === "True") {
        issues.push(`${condition.type}: ${condition.message || "Active"}`);
      }
    }

    const warningConditions = node.getWarningConditions();
    for (const condition of warningConditions) {
      if (!issues.some((i) => i.startsWith(condition.type))) {
        issues.push(`${condition.type}: ${condition.message || "Warning"}`);
      }
    }

    return issues;
  };

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

  const sortedNodes = useMemo(() => {
    let filtered = [...nodes];

    // Apply text filter
    if (filterText.trim()) {
      const lowerFilter = filterText.toLowerCase();
      filtered = filtered.filter((node) => {
        const nodeName = node.getName().toLowerCase();
        const taints = getNodeTaintsFormatted(node).toLowerCase();
        const status = getNodeStatus(node).toLowerCase();
        return nodeName.includes(lowerFilter) || taints.includes(lowerFilter) || status.includes(lowerFilter);
      });
    }

    // Sort
    return filtered.sort((a, b) => {
      let compareValue = 0;

      switch (sortColumn) {
        case "name":
          compareValue = a.getName().localeCompare(b.getName());
          break;
        case "status": {
          const statusA = getNodeStatus(a);
          const statusB = getNodeStatus(b);
          const severityOrder = { NotReady: 3, SchedulingDisabled: 2, Unknown: 1, Ready: 0 };
          compareValue = severityOrder[statusB] - severityOrder[statusA];
          break;
        }
        case "pods": {
          const podsA = getPodsOnNode(a.getName()).length;
          const podsB = getPodsOnNode(b.getName()).length;
          compareValue = podsA - podsB;
          break;
        }
        case "cpu": {
          const cpuA = a.getCpuCapacity() ?? 0;
          const cpuB = b.getCpuCapacity() ?? 0;
          compareValue = cpuA - cpuB;
          break;
        }
        case "memory": {
          const memA = a.getMemoryCapacity();
          const memB = b.getMemoryCapacity();
          // Simple string comparison for memory
          compareValue = String(memA).localeCompare(String(memB));
          break;
        }
        case "issues": {
          const issuesA = getNodeIssues(a).length;
          const issuesB = getNodeIssues(b).length;
          compareValue = issuesA - issuesB;
          break;
        }
        case "taints": {
          const taintsA = getNodeTaintsFormatted(a);
          const taintsB = getNodeTaintsFormatted(b);
          compareValue = taintsA.localeCompare(taintsB);
          break;
        }
      }

      return sortDirection === "asc" ? compareValue : -compareValue;
    });
  }, [nodes, sortColumn, sortDirection, filterText]);

  const displayedNodes = useMemo(() => {
    if (!showOnlyProblems) return sortedNodes;
    return sortedNodes.filter((node) => {
      const status = getNodeStatus(node);
      const issues = getNodeIssues(node);
      return status !== "Ready" || issues.length > 0;
    });
  }, [sortedNodes, showOnlyProblems]);

  const getNodeStatusColor = (status: string) => {
    switch (status) {
      case "Ready":
        return "#4caf50";
      case "NotReady":
        return "#f44336";
      case "SchedulingDisabled":
        return "#ff9800";
      default:
        return "#9e9e9e";
    }
  };

  const getPodsOnNode = (nodeName: string) => {
    return pods.filter((pod) => pod.getNodeName() === nodeName);
  };

  const formatMemory = (memory: string | number) => {
    if (typeof memory === "number") {
      return `${(memory / 1024 / 1024 / 1024).toFixed(2)} GiB`;
    }

    // Memory is in format like "8145692Ki" or "7.75Gi"
    const match = memory.match(/^([0-9.]+)([A-Za-z]+)$/);
    if (!match) return memory;

    const value = parseFloat(match[1]);
    const unit = match[2];

    // Convert to GiB
    if (unit === "Ki") {
      return `${(value / 1024 / 1024).toFixed(2)} GiB`;
    } else if (unit === "Mi") {
      return `${(value / 1024).toFixed(2)} GiB`;
    } else if (unit === "Gi") {
      return `${value.toFixed(2)} GiB`;
    } else if (unit === "Ti") {
      return `${(value * 1024).toFixed(2)} GiB`;
    }

    return memory;
  };

  try {
    return (
      <>
        <style>{stylesInline}</style>
        <div className={styles.page}>
          <header className={styles.header}>
            <div>
              <div className={styles.title}>Nodes Analysis</div>
              <div className={styles.subtitle}>Detailed node status and taint distribution.</div>
            </div>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
              <input
                type="text"
                placeholder="Filter nodes..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                style={{
                  padding: "0.5rem",
                  borderRadius: "4px",
                  border: "1px solid var(--borderColor, #444)",
                  backgroundColor: "var(--contentColor, #1e1e1e)",
                  color: "var(--textColorPrimary, #fff)",
                  minWidth: "200px",
                }}
              />
              <label className={styles.filterToggle}>
                <input
                  type="checkbox"
                  checked={showOnlyProblems}
                  onChange={(e) => setShowOnlyProblems(e.target.checked)}
                />
                Show only problems
              </label>
            </div>
          </header>

          <section className={styles.section}>
            <h3>Node Status</h3>
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
            <h3>
              Nodes Details{" "}
              {displayedNodes.length < nodes.length &&
                `(${displayedNodes.length} of ${nodes.length}${showOnlyProblems ? " with issues" : ""})`}
            </h3>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: "30px" }}></th>
                  <th onClick={() => handleSort("name")} style={{ cursor: "pointer" }}>
                    Node {sortColumn === "name" && (sortDirection === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => handleSort("status")} style={{ cursor: "pointer" }}>
                    Status {sortColumn === "status" && (sortDirection === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => handleSort("pods")} style={{ cursor: "pointer" }}>
                    Pods {sortColumn === "pods" && (sortDirection === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => handleSort("cpu")} style={{ cursor: "pointer" }}>
                    CPU {sortColumn === "cpu" && (sortDirection === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => handleSort("memory")} style={{ cursor: "pointer" }}>
                    Memory {sortColumn === "memory" && (sortDirection === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => handleSort("taints")} style={{ cursor: "pointer" }}>
                    Taints {sortColumn === "taints" && (sortDirection === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => handleSort("issues")} style={{ cursor: "pointer" }}>
                    Issues {sortColumn === "issues" && (sortDirection === "asc" ? "↑" : "↓")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedNodes.map((node) => {
                  const nodeName = node.getName();
                  const isExpanded = expandedNodes.has(nodeName);
                  const status = getNodeStatus(node);
                  const issues = getNodeIssues(node);
                  const podsOnNode = getPodsOnNode(nodeName);
                  const cpuCapacity = node.getCpuCapacity() ?? 0;
                  const memoryCapacity = formatMemory(node.getMemoryCapacity());
                  const taintsFormatted = getNodeTaintsFormatted(node);

                  return (
                    <React.Fragment key={nodeName}>
                      <tr className={styles.namespaceRow} onClick={() => toggleNodeExpanded(nodeName)}>
                        <td>
                          <span className={styles.expandIcon}>{isExpanded ? "▼" : "▶"}</span>
                        </td>
                        <td className={styles.podName}>{nodeName}</td>
                        <td>
                          <span className={styles.statusBadge} style={{ backgroundColor: getNodeStatusColor(status) }}>
                            {status}
                          </span>
                        </td>
                        <td>{podsOnNode.length}</td>
                        <td>{cpuCapacity.toFixed(2)} cores</td>
                        <td>{memoryCapacity}</td>
                        <td>{taintsFormatted}</td>
                        <td>
                          {issues.length > 0 ? (
                            <span className={styles.issuesBadge}>
                              {issues.length} issue{issues.length > 1 ? "s" : ""}
                            </span>
                          ) : (
                            <span style={{ color: "#4caf50" }}>None</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} className={styles.expandedCell}>
                            <div className={styles.podDetails}>
                              {issues.length > 0 && (
                                <div>
                                  <h4 className={styles.podDetailsHeader}>Issues</h4>
                                  <ul className={styles.issuesList}>
                                    {issues.map((issue, idx) => (
                                      <li key={idx} className={styles.issueItem}>
                                        {issue}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {node.getTaints().length > 0 && (
                                <div>
                                  <h4 className={styles.podDetailsHeader}>Taints</h4>
                                  <ul className={styles.issuesList}>
                                    {node.getTaints().map((taint, idx) => (
                                      <li key={idx} className={styles.issueItem}>
                                        {formatNodeTaint(taint)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {podsOnNode.length > 0 && (
                                <div>
                                  <h4 className={styles.podDetailsHeader}>Pods on this node ({podsOnNode.length})</h4>
                                  <table className={styles.podTable}>
                                    <thead>
                                      <tr>
                                        <th>Name</th>
                                        <th>Namespace</th>
                                        <th>Status</th>
                                        <th>Restarts</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {podsOnNode.slice(0, 20).map((pod) => {
                                        const phase = pod.getStatusPhase();
                                        const restarts = pod.getRestartsCount();
                                        const hasIssues = pod.hasIssues();

                                        return (
                                          <tr
                                            key={pod.getId()}
                                            className={hasIssues || restarts > 0 ? styles.podWithIssues : ""}
                                          >
                                            <td>{pod.getName()}</td>
                                            <td>{pod.getNs()}</td>
                                            <td>
                                              <span
                                                className={styles.statusBadge}
                                                style={{
                                                  backgroundColor:
                                                    phase === "Running"
                                                      ? "#4caf50"
                                                      : phase === "Pending"
                                                        ? "#ff9800"
                                                        : phase === "Failed"
                                                          ? "#f44336"
                                                          : phase === "Succeeded"
                                                            ? "#2196f3"
                                                            : "#9e9e9e",
                                                }}
                                              >
                                                {phase}
                                              </span>
                                            </td>
                                            <td>
                                              {restarts > 0 ? (
                                                <span style={{ color: "#ff9800" }}>{restarts}</span>
                                              ) : (
                                                restarts
                                              )}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                  {podsOnNode.length > 20 && (
                                    <div className={styles.filteredInfo}>
                                      ... and {podsOnNode.length - 20} more pods
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className={styles.section}>
            <h3>Node Taints Distribution</h3>
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
        </div>
      </>
    );
  } catch (error) {
    return <ErrorPage error={error} extension={props.extension} />;
  }
});
