/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { StatsIcon } from "./icons";
import { SreStatsPage } from "./pages/sre-stats-page";

export default class SreStatsRenderer extends Renderer.LensExtension {
  clusterPages = [
    {
      id: "sre-stats",
      components: {
        Page: () => <SreStatsPage extension={this} />,
      },
    },
  ];

  clusterPageMenus = [
    {
      id: "sre-stats",
      title: "SRE Stats",
      target: { pageId: "sre-stats" },
      components: {
        Icon: StatsIcon,
      },
    },
  ];
}
