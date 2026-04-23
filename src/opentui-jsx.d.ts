import type { BoxProps, TextProps } from "@opentui/solid/src/types/elements";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      box: BoxProps;
      text: TextProps;
      span: TextProps;
      input: unknown;
      select: unknown;
      scrollbox: unknown;
      code: unknown;
      markdown: unknown;
      ascii_font: unknown;
      tab_select: unknown;
      textarea: unknown;
      link: unknown;
      b: unknown;
      strong: unknown;
      i: unknown;
      em: unknown;
      u: unknown;
      br: unknown;
      a: unknown;
    }
  }
}
