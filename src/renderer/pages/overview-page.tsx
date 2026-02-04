import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import React, { useEffect, useMemo, useState } from "react";
import { ErrorPage } from "../components/error-page";
import styles from "./sre-stats-page.module.scss";
import stylesInline from "./sre-stats-page.module.scss?inline";

const {
  K8sApi: { nodesStore, podsStore, eventStore, namespaceStore },
  Navigation,
} = Renderer;

export interface OverviewPageProps {
  extension: Renderer.LensExtension;
}

function StatCard({
  label,
  value,
  hint,
  status,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  status?: "healthy" | "warning" | "critical" | "info";
  onClick?: () => void;
}) {
  const statusColors = {
    healthy: "#4caf50",
    warning: "#ff9800",
    critical: "#f44336",
    info: "#2196f3",
  };

  const cardStyle = status
    ? {
        borderLeft: `4px solid ${statusColors[status]}`,
        cursor: onClick ? "pointer" : "default",
      }
    : { cursor: onClick ? "pointer" : "default" };

  return (
    <div className={styles.card} style={cardStyle} onClick={onClick}>
      <div className={styles.cardLabel}>{label}</div>
      <div className={styles.cardValue}>{value}</div>
      {hint ? <div className={styles.cardHint}>{hint}</div> : null}
    </div>
  );
}

export const OverviewPage = observer((props: OverviewPageProps) => {
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
  const namespaces = namespaceStore.items;
  const events = eventStore.items;

  const [showOnlyProblems, setShowOnlyProblems] = useState(true);

  const summary = useMemo(() => {
    let runningPods = 0;
    let pendingPods = 0;
    let failedPods = 0;
    let podsWithIssues = 0;
    let totalRestarts = 0;
    let nodesNotReady = 0;
    let nodesWithWarnings = 0;

    let warningEvents = 0;
    let normalEvents = 0;

    for (const pod of pods) {
      const phase = pod.getStatusPhase();

      if (phase === "Running") runningPods++;
      if (phase === "Pending") pendingPods++;
      if (phase === "Failed") failedPods++;

      if (pod.hasIssues()) podsWithIssues++;

      totalRestarts += pod.getRestartsCount();
    }

    for (const node of nodes) {
      const readyCondition = node.getConditions().find((c) => c.type === "Ready");
      if (readyCondition?.status !== "True") {
        nodesNotReady++;
      }
      if (node.getWarningConditions().length > 0) {
        nodesWithWarnings++;
      }
    }

    for (const event of events) {
      const count = event.count ?? 1;

      if (event.isWarning()) {
        warningEvents += count;
      } else if (event.type === "Normal") {
        normalEvents += count;
      }
    }

    const clusterHealthScore =
      nodes.length > 0
        ? Math.round(
            ((nodes.length - nodesNotReady) / nodes.length) * 40 +
              ((pods.length - podsWithIssues - failedPods) / Math.max(pods.length, 1)) * 40 +
              (warningEvents === 0 ? 20 : Math.max(0, 20 - warningEvents)),
          )
        : 100;

    return {
      nodes: nodes.length,
      namespaces: namespaces.length,
      totalPods: pods.length,
      runningPods,
      pendingPods,
      failedPods,
      podsWithIssues,
      totalRestarts,
      totalEvents: events.length,
      warningEvents,
      normalEvents,
      nodesNotReady,
      nodesWithWarnings,
      clusterHealthScore,
    };
  }, [nodes, pods, namespaces, events]);

  const recentWarningEvents = useMemo(() => {
    return events
      .filter((event) => event.isWarning())
      .sort((a, b) => {
        const timeA = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
        const timeB = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
        return timeB - timeA;
      })
      .slice(0, 10);
  }, [events]);

  const navigateToPodsPage = () => {
    Navigation.navigate("sre-stats-pods");
  };

  const navigateToNodesPage = () => {
    Navigation.navigate("sre-stats-nodes");
  };

  const navigateToEventsPage = () => {
    Navigation.navigate("sre-stats-events");
  };

  const formatAge = (timestamp: string | undefined) => {
    if (!timestamp) return "unknown";
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    return `${diffDays}d`;
  };

  const getHealthStatus = (score: number): "healthy" | "warning" | "critical" => {
    if (score >= 80) return "healthy";
    if (score >= 50) return "warning";
    return "critical";
  };

  try {
    return (
      <>
        <style>{stylesInline}</style>
        <div className={styles.page}>
          <header className={styles.header}>
            <div>
              <div className={styles.title}>Cluster Overview</div>
              <div className={styles.subtitle}>High-level summary of cluster resources and health.</div>
            </div>
            <label className={styles.filterToggle}>
              <input
                type="checkbox"
                checked={showOnlyProblems}
                onChange={(e) => setShowOnlyProblems(e.target.checked)}
              />
              Show only problems
            </label>
          </header>

          <section className={styles.section}>
            <h3>Cluster Health</h3>
            <div className={styles.cards}>
              <StatCard
                label="Health Score"
                value={`${summary.clusterHealthScore}%`}
                hint="Overall cluster health"
                status={getHealthStatus(summary.clusterHealthScore)}
              />
              {(!showOnlyProblems || summary.nodesNotReady > 0) && (
                <StatCard
                  label="Nodes Not Ready"
                  value={summary.nodesNotReady}
                  hint="Click to view nodes"
                  status={summary.nodesNotReady > 0 ? "critical" : "healthy"}
                  onClick={summary.nodesNotReady > 0 ? navigateToNodesPage : undefined}
                />
              )}
              {(!showOnlyProblems || summary.nodesWithWarnings > 0) && (
                <StatCard
                  label="Nodes with Warnings"
                  value={summary.nodesWithWarnings}
                  hint="Click to view nodes"
                  status={summary.nodesWithWarnings > 0 ? "warning" : "healthy"}
                  onClick={summary.nodesWithWarnings > 0 ? navigateToNodesPage : undefined}
                />
              )}
            </div>
          </section>

          <section className={styles.section}>
            <h3>Pod Status</h3>
            <div className={styles.cards}>
              {!showOnlyProblems && <StatCard label="Total Pods" value={summary.totalPods} status="info" />}
              {!showOnlyProblems && <StatCard label="Running" value={summary.runningPods} status="healthy" />}
              {(!showOnlyProblems || summary.pendingPods > 0) && (
                <StatCard
                  label="Pending"
                  value={summary.pendingPods}
                  hint="Click to view pods"
                  status={summary.pendingPods > 0 ? "warning" : "healthy"}
                  onClick={summary.pendingPods > 0 ? navigateToPodsPage : undefined}
                />
              )}
              {(!showOnlyProblems || summary.failedPods > 0) && (
                <StatCard
                  label="Failed"
                  value={summary.failedPods}
                  hint="Click to view pods"
                  status={summary.failedPods > 0 ? "critical" : "healthy"}
                  onClick={summary.failedPods > 0 ? navigateToPodsPage : undefined}
                />
              )}
              {(!showOnlyProblems || summary.podsWithIssues > 0) && (
                <StatCard
                  label="With Issues"
                  value={summary.podsWithIssues}
                  hint="Click to view pods"
                  status={summary.podsWithIssues > 0 ? "warning" : "healthy"}
                  onClick={summary.podsWithIssues > 0 ? navigateToPodsPage : undefined}
                />
              )}
              {(!showOnlyProblems || summary.totalRestarts > 10) && (
                <StatCard
                  label="Total Restarts"
                  value={summary.totalRestarts}
                  hint="Click to view pods"
                  status={summary.totalRestarts > 10 ? "warning" : "healthy"}
                  onClick={summary.totalRestarts > 10 ? navigateToPodsPage : undefined}
                />
              )}
            </div>
          </section>

          <section className={styles.section}>
            <h3>Events</h3>
            <div className={styles.cards}>
              {!showOnlyProblems && <StatCard label="Total Events" value={summary.totalEvents} status="info" />}
              {(!showOnlyProblems || summary.warningEvents > 0) && (
                <StatCard
                  label="Warnings"
                  value={summary.warningEvents}
                  hint="Click to view events"
                  status={summary.warningEvents > 0 ? "warning" : "healthy"}
                  onClick={summary.warningEvents > 0 ? navigateToEventsPage : undefined}
                />
              )}
              {!showOnlyProblems && <StatCard label="Normal" value={summary.normalEvents} status="healthy" />}
            </div>
          </section>

          {recentWarningEvents.length > 0 && (
            <section className={styles.section}>
              <h3>Recent Warning Events</h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Age</th>
                    <th>Reason</th>
                    <th>Resource</th>
                    <th>Namespace</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {recentWarningEvents.map((event, idx) => (
                    <tr key={`${event.getName()}-${idx}`}>
                      <td className={styles.ageCell}>{formatAge(event.lastTimestamp)}</td>
                      <td>
                        <span className={styles.reasonBadge} style={{ backgroundColor: "#ff9800" }}>
                          {event.reason}
                        </span>
                      </td>
                      <td>{event.involvedObject.name}</td>
                      <td>{event.involvedObject.namespace || "cluster"}</td>
                      <td className={styles.eventMessage}>{event.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </>
    );
  } catch (error) {
    return <ErrorPage error={error} extension={props.extension} />;
  }
});
