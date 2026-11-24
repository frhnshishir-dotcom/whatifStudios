// Small stroke icons (24-unit viewBox), drawn inline so the app has no icon dependency.
const PATHS: Record<string, string> = {
  logo: 'M12 3c4 3 6 6 6 9a6 6 0 0 1-12 0c0-3 2-6 6-9zm0 6v9m-3-4l3 3 3-3',
  select: 'M5 3l13 8-6 1.5L9.5 19z',
  terrain: 'M2 19l6-9 4 5 3-4 7 8z',
  raise: 'M12 19V6m-5 5l5-5 5 5M4 21h16',
  lower: 'M12 5v13m-5-5l5 5 5-5M4 3h16',
  water: 'M12 3c3.5 4.5 6 7.5 6 10.5a6 6 0 0 1-12 0C6 10.5 8.5 7.5 12 3z',
  source: 'M12 21v-8m0 0c-3 0-5-2-5-5h10c0 3-2 5-5 5zM9 3h6',
  drain: 'M4 8h16M7 12h10m-7 4h4m-2 3v2',
  channel: 'M3 7c4 0 4 4 9 4s5-4 9-4M3 15c4 0 4 4 9 4s5-4 9-4',
  waterfall: 'M5 4h14M8 4v10m4-10v14m4-14v10M6 20h12',
  rock: 'M4 18l3-7 5-3 5 4 3 6z',
  tree: 'M12 3l6 8h-3l4 6H5l4-6H6zm0 14v4',
  flowers: 'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v8m-4-3c2 0 4 1 4 3m4-3c-2 0-4 1-4 3',
  mushroom: 'M4 12a8 6 0 0 1 16 0zm6 0v7h4v-7',
  bridge: 'M3 16h18M3 16c3-5 15-5 18 0M7 13v3m5-4v4m5-3v3',
  cottage: 'M4 11l8-7 8 7m-14-1v10h12V10m-8 10v-5h4v5',
  mill: 'M12 12m-6 0a6 6 0 1 0 12 0 6 6 0 1 0-12 0M12 6v12M6 12h12M7.8 7.8l8.4 8.4m0-8.4l-8.4 8.4',
  ripple: 'M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M12 12m-6 0a6 6 0 1 0 12 0 6 6 0 1 0-12 0M12 12m-10 0a10 10 0 1 0 20 0',
  eraser: 'M8 20h12M4 15l9-9 6 6-6 6H9z',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 7l5 5-5 5m5-5H9a5 5 0 0 0 0 10h3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .4-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 2L6 8.4 4 8 3 11l2 1v0l-2 1 1 3 2-.4 1.5 1.5L7 19l3 1 1-2h2l1 2 3-1-.5-2 1.5-1.4 2 .4 1-3z',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zm6 0h4v16h-4z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  save: 'M5 3h11l3 3v15H5zm3 0v5h7V3M8 21v-7h8v7',
  dice: 'M4 4h16v16H4zM8 9a1 1 0 1 0 2 0 1 1 0 1 0-2 0M14 15a1 1 0 1 0 2 0 1 1 0 1 0-2 0M14 9a1 1 0 1 0 2 0 1 1 0 1 0-2 0M8 15a1 1 0 1 0 2 0 1 1 0 1 0-2 0',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-14v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4m0-14.2l-1.4 1.4M6.3 17.7l-1.4 1.4',
  folder: 'M3 6h6l2 2h10v11H3z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  rain: 'M7 15a4 4 0 0 1 .5-8A5 5 0 0 1 17 8a3.5 3.5 0 0 1 0 7M8 18l-1 3m5-3l-1 3m5-3l-1 3',
  fog: 'M3 9h18M5 13h14M3 17h18',
  wind: 'M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5m11-5v5h-5',
  upload: 'M12 16V4m-5 5l5-5 5 5M4 20h16',
  download: 'M12 4v12m-5-5l5 5 5-5M4 20h16',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
