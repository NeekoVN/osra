declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.wav' {
  const src: string;
  export default src;
}

interface ImportMeta {
  glob<T = unknown>(pattern: string, options?: { eager?: boolean; import?: string; query?: string }): Record<string, T>;
}
