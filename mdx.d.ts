declare module '*.mdx' {
  import type { ComponentType } from 'react';
  const Component: ComponentType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const meta: any;
  export default Component;
}
