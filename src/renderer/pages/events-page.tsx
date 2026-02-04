import { Renderer } from "@freelensapp/extensions";
import { type KubeEvent } from "@freelensapp/kube-object";
import { observer } from "mobx-react";
import React, { useEffect, useMemo, useState } from "react";
import { ErrorPage } from "../components/error-page";
import styles from "./sre-stats-page.module.scss";
import stylesInline from "./sre-stats-page.module.scss?inline";

const {
  K8sApi: { eventStore, namespaceStore },
} = Renderer;

export interface EventsPageProps {
  extension: Renderer.LensExtension;
}

type TimeFilter = "1h" | "6h" | "24h" | "7d" | "all";

function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>{label}</div>
      <div className={styles.cardValue}>{value}</div>
      {hint ? <div className={styles.cardHint}>{hint}</div> : null}
    </div>
  );
}

function buildWarningReasons(events: KubeEvent[]) {
  const reasons = new Map<string, { count: number; namespaces: Set<string>; resources: string[] }>();

  for (const event of events) {
    if (!event.isWarning()) {
      continue;
    }

    const reason = event.reason ?? "<unknown>";
    const count = event.count ?? 1;
    const namespace = event.involvedObject.namespace || "cluster";
    const resource = event.involvedObject.name;

    const entry = reasons.get(reason) ?? { count: 0, namespaces: new Set(), resources: [] };
    entry.count += count;
    entry.namespaces.add(namespace);
    if (entry.resources.length < 10) {
      entry.resources.push(resource);
    }
    reasons.set(reason, entry);
  }

  return Array.from(reasons.entries())
    .map(([reason, data]) => ({
      reason,
      count: data.count,
      namespaces: Array.from(data.namespaces),
      resources: data.resources,
    }))
    .sort((a, b) => b.count - a.count);
}

export const EventsPage = observer((props: EventsPageProps) => {
  const [showOnlyWarnings, setShowOnlyWarnings] = useState(true);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("1h");
  const [expandedReasons, setExpandedReasons] = useState<Set<string>>(new Set());

  useEffect(() => {
    const disposers = [namespaceStore.subscribe(), eventStore.subscribe()];

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
      console.info("[SRE-STATS] Loading events for namespaces", namespaces.length);
      eventStore.loadAll({ namespaces, onLoadFailure });
    } else {
      console.info("[SRE-STATS] No namespaces available, falling back to current context");
      eventStore.loadAll({ onLoadFailure });
    }
  }, [allNamespaces.join("|")]);

  const events = eventStore.items;

  const getTimeFilterMs = (filter: TimeFilter): number => {
    switch (filter) {
      case "1h":
        return 3600000;
      case "6h":
        return 21600000;
      case "24h":
        return 86400000;
      case "7d":
        return 604800000;
      default:
        return Number.MAX_SAFE_INTEGER;
    }
  };

  const filteredEvents = useMemo(() => {
    const now = Date.now();
    const maxAge = getTimeFilterMs(timeFilter);

    return events.filter((event) => {
      // Filter by time
      const timestamp = event.lastTimestamp || event.firstTimestamp;
      if (timestamp) {
        const eventTime = new Date(timestamp).getTime();
        if (now - eventTime > maxAge) return false;
      }

      // Filter by warning status
      if (showOnlyWarnings && !event.isWarning()) return false;

      return true;
    });
  }, [events, timeFilter, showOnlyWarnings]);

  const toggleReasonExpanded = (reason: string) => {
    const newExpanded = new Set(expandedReasons);
    if (newExpanded.has(reason)) {
      newExpanded.delete(reason);
    } else {
      newExpanded.add(reason);
    }
    setExpandedReasons(newExpanded);
  };

  const formatAge = (timestamp: string | undefined) => {
    if (!timestamp) return "unknown";
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const eventSummary = useMemo(() => {
    let warnings = 0;
    let normals = 0;
    let others = 0;

    for (const event of filteredEvents) {
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
  }, [filteredEvents]);

  const warningReasons = useMemo(() => buildWarningReasons(filteredEvents), [filteredEvents]);

  const namespaceEventCounts = useMemo(() => {
    const counts = new Map<string, { warnings: number; total: number }>();

    for (const event of filteredEvents) {
      const namespace = event.involvedObject.namespace || "cluster";
      const entry = counts.get(namespace) ?? { warnings: 0, total: 0 };
      const count = event.count ?? 1;

      entry.total += count;
      if (event.isWarning()) {
        entry.warnings += count;
      }

      counts.set(namespace, entry);
    }

    return Array.from(counts.entries())
      .map(([namespace, data]) => ({ namespace, ...data }))
      .sort((a, b) => b.warnings - a.warnings)
      .slice(0, 10);
  }, [filteredEvents]);

  try {
    return (
      <>
        <style>{stylesInline}</style>
        <div className={styles.page}>
          <header className={styles.header}>
            <div>
              <div className={styles.title}>Events Analysis</div>
              <div className={styles.subtitle}>Cluster events summary and warning reasons.</div>
            </div>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
              <div className={styles.timeFilter}>
                <label>Time range:</label>
                <select
                  value={timeFilter}
                  onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
                  className={styles.timeSelect}
                >
                  <option value="1h">Last 1 hour</option>
                  <option value="6h">Last 6 hours</option>
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="all">All time</option>
                </select>
              </div>
              <label className={styles.filterToggle}>
                <input
                  type="checkbox"
                  checked={showOnlyWarnings}
                  onChange={(e) => setShowOnlyWarnings(e.target.checked)}
                />
                Show only warnings
              </label>
            </div>
          </header>

          <section className={styles.section}>
            <h3>Events Summary</h3>
            <div className={styles.cards}>
              <StatCard label="Total events" value={eventSummary.total} />
              <StatCard label="Warnings" value={eventSummary.warnings} />
              <StatCard label="Normal" value={eventSummary.normals} />
              <StatCard label="Other" value={eventSummary.others} />
            </div>
          </section>

          {namespaceEventCounts.length > 0 && (
            <section className={styles.section}>
              <h3>Top Namespaces by Warning Count</h3>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Namespace</th>
                    <th>Warnings</th>
                    <th>Total Events</th>
                  </tr>
                </thead>
                <tbody>
                  {namespaceEventCounts.map((item) => (
                    <tr key={item.namespace}>
                      <td>{item.namespace}</td>
                      <td>
                        <span className={styles.reasonBadge} style={{ backgroundColor: "#ff9800" }}>
                          {item.warnings}
                        </span>
                      </td>
                      <td>{item.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className={styles.section}>
            <h3>Warning Reasons</h3>
            {warningReasons.length === 0 ? (
              <div className={styles.empty}>No warning events detected.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th style={{ width: "30px" }}></th>
                    <th>Warning reason</th>
                    <th>Count</th>
                    <th>Namespaces</th>
                  </tr>
                </thead>
                <tbody>
                  {warningReasons.map((item) => {
                    const isExpanded = expandedReasons.has(item.reason);

                    return (
                      <React.Fragment key={item.reason}>
                        <tr className={styles.namespaceRow} onClick={() => toggleReasonExpanded(item.reason)}>
                          <td>
                            <span className={styles.expandIcon}>{isExpanded ? "▼" : "▶"}</span>
                          </td>
                          <td>
                            <span className={styles.reasonBadge} style={{ backgroundColor: "#ff9800" }}>
                              {item.reason}
                            </span>
                          </td>
                          <td>{item.count}</td>
                          <td>{item.namespaces.join(", ")}</td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={4} className={styles.expandedCell}>
                              <div className={styles.podDetails}>
                                <h4 className={styles.podDetailsHeader}>Affected Resources (sample)</h4>
                                <ul className={styles.issuesList}>
                                  {item.resources.map((resource, idx) => (
                                    <li key={idx} className={styles.issueItem}>
                                      {resource}
                                    </li>
                                  ))}
                                </ul>

                                <h4 className={styles.podDetailsHeader}>Recent Events</h4>
                                <table className={styles.podTable}>
                                  <thead>
                                    <tr>
                                      <th>Age</th>
                                      <th>Resource</th>
                                      <th>Namespace</th>
                                      <th>Message</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {filteredEvents
                                      .filter((e) => e.reason === item.reason && e.isWarning())
                                      .slice(0, 10)
                                      .map((event, idx) => (
                                        <tr key={idx}>
                                          <td className={styles.ageCell}>{formatAge(event.lastTimestamp)}</td>
                                          <td>{event.involvedObject.name}</td>
                                          <td>{event.involvedObject.namespace || "cluster"}</td>
                                          <td className={styles.eventMessage}>{event.message}</td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
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
