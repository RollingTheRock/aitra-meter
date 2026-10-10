/// <reference types="vite/client" />

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const content: string;
  export default content;
}
