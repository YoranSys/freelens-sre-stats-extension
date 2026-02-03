/**
 * Copyright (c) Yoransys. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import svgIcon from "./example.svg?raw";

const {
  Component: { Icon },
} = Renderer;

export function StatsIcon(props: Renderer.Component.IconProps) {
  return <Icon {...props} svg={svgIcon} />;
}
