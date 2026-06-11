declare module "react-simple-maps" {
  import type { ComponentType, ReactNode } from "react";

  type MapProps = Record<string, unknown> & {
    children?: ReactNode | ((args: { geographies: Array<Record<string, unknown>> }) => ReactNode);
  };

  export const ComposableMap: ComponentType<MapProps>;
  export const Geographies: ComponentType<MapProps>;
  export const Geography: ComponentType<MapProps>;
}
