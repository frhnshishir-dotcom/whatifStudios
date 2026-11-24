import { Icon } from './Icon';
import { useUI, type ToolId } from '../store';

export const TOOL_GROUPS: Array<{ name: string; tools: Array<{ id: ToolId; label: string; icon: string; key?: string }> }> = [
  { name: 'Interaction', tools: [{ id: 'select', label: 'Select / inspect', icon: 'select', key: 'V' }, { id: 'ripple', label: 'Ripple', icon: 'ripple', key: 'R' }, { id: 'eraser', label: 'Eraser', icon: 'eraser', key: 'E' }] },
  { name: 'Terrain', tools: [{ id: 'terrain', label: 'Terrain brush', icon: 'terrain', key: '1' }, { id: 'raise', label: 'Raise terrain', icon: 'raise', key: '2' }, { id: 'lower', label: 'Lower terrain', icon: 'lower', key: '3' }] },
  { name: 'Water', tools: [{ id: 'water', label: 'Water brush', icon: 'water', key: '4' }, { id: 'source', label: 'Water source', icon: 'source', key: '5' }, { id: 'drain', label: 'Water drain', icon: 'drain', key: '6' }, { id: 'channel', label: 'River / channel', icon: 'channel', key: '7' }, { id: 'waterfall', label: 'Waterfall', icon: 'waterfall', key: '8' }] },
  { name: 'Vegetation', tools: [{ id: 'tree', label: 'Tree', icon: 'tree', key: 'T' }, { id: 'flowers', label: 'Grass & flowers', icon: 'flowers', key: 'G' }, { id: 'mushroom', label: 'Mushrooms', icon: 'mushroom', key: 'M' }] },
  { name: 'Rocks', tools: [{ id: 'rock', label: 'Rock', icon: 'rock', key: 'K' }] },
  { name: 'Structures', tools: [{ id: 'bridge', label: 'Bridge', icon: 'bridge', key: 'B' }, { id: 'cottage', label: 'Cottage', icon: 'cottage', key: 'C' }, { id: 'mill', label: 'Water mill', icon: 'mill', key: 'W' }] },
];

/** Tools whose implementation exists (filled in as milestones land). */
export const AVAILABLE_TOOLS = new Set<ToolId>(['select', 'ripple']);

export function Toolbar() {
  const tool = useUI((s) => s.tool);
  const setTool = useUI((s) => s.setTool);
  return (
    <nav className="toolbar" aria-label="Tools">
      {TOOL_GROUPS.map((g) => (
        <div className="tool-group" key={g.name}>
          <div className="tool-group-name">{g.name}</div>
          {g.tools.map((t) => {
            const ok = AVAILABLE_TOOLS.has(t.id);
            return (
              <button key={t.id} className={`tool-btn${tool === t.id ? ' active' : ''}`} disabled={!ok} onClick={() => setTool(t.id)}
                title={`${t.label}${t.key ? ` (${t.key})` : ''}${ok ? '' : ' – not available yet'}`} aria-label={t.label} data-tool={t.id}>
                <Icon name={t.icon} size={17} />
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
