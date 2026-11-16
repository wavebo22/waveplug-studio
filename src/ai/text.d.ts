// esbuild loads the host script as text for the browser preview (scripts/build.mjs)
declare module "*.jsx" {
  const text: string;
  export default text;
}
