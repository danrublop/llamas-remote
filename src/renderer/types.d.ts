// Ambient module shims so TS understands image imports handled by webpack's asset/resource.
// (The live IPC surface — window.llamasAPI / window.notebookAPI — is declared inline in the
// renderer .tsx files, not here.)

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}
