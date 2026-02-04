/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { StatsIcon } from "./icons";
import { EventsPage } from "./pages/events-page";
import { NodesPage } from "./pages/nodes-page";
import { OverviewPage } from "./pages/overview-page";
import { PodsPage } from "./pages/pods-page";

export default class SreStatsRenderer extends Renderer.LensExtension {
  clusterPages = [
    {
      id: "sre-stats-overview",
      components: {
        Page: () => <OverviewPage extension={this} />,
      },
    },
    {
      id: "sre-stats-nodes",
      components: {
        Page: () => <NodesPage extension={this} />,
      },
    },
    {
      id: "sre-stats-pods",
      components: {
        Page: () => <PodsPage extension={this} />,
      },
    },
    {
      id: "sre-stats-events",
      components: {
        Page: () => <EventsPage extension={this} />,
      },
    },
  ];

  clusterPageMenus = [
    {
      id: "sre-stats",
      title: "SRE Stats",
      components: {
        Icon: StatsIcon,
      },
    },
    {
      id: "sre-stats-overview",
      parentId: "sre-stats",
      title: "Overview",
      target: { pageId: "sre-stats-overview" },
      components: {
        Icon: null as never,
      },
    },
    {
      id: "sre-stats-nodes",
      parentId: "sre-stats",
      title: "Nodes",
      target: { pageId: "sre-stats-nodes" },
      components: {
        Icon: null as never,
      },
    },
    {
      id: "sre-stats-pods",
      parentId: "sre-stats",
      title: "Pods",
      target: { pageId: "sre-stats-pods" },
      components: {
        Icon: null as never,
      },
    },
    {
      id: "sre-stats-events",
      parentId: "sre-stats",
      title: "Events",
      target: { pageId: "sre-stats-events" },
      components: {
        Icon: null as never,
      },
    },
  ];
}
