// The help box: a small panel docked in the viewport you are working in, explaining the active tool and whatever is
// going on right now (a selected bone, the whole character, Reach to…, drafts), with its keys. Brief by design: the
// inspector only holds values and buttons; the words live here.

export type HelpView = 'sketch' | 'tile' | 'scene' | '3d';
export interface HelpState {
  tool: 'pen' | 'select' | 'erase' | 'brush' | 'edit';
  view: HelpView;
  /** Selected bone: its name, its part, whether it is an arm or leg, pinned. */
  bone?: { name: string; part: string; limb: boolean; pinned: boolean } | null;
  rootSel?: boolean;
  reaching?: { what: 'hand' | 'foot'; attach: boolean } | null;
  drafts?: number;
  altPart?: string | null;
  target?: string | null;
  locked?: boolean;
  contacts?: number;
  characters?: number;
  /** A selected object (shape or imported mesh): its name and lock. */
  obj?: { name: string; locked: boolean; picking?: boolean } | null;
  /** A new figure is taking shape (strokes drawn apart from the characters). */
  pending?: boolean;
}
type Row = [string, string];
interface Block { title: string; key?: string; rows: Row[]; note?: string }

const TOOL: Record<HelpState['tool'], { name: string; key: string }> = {
  pen: { name: 'Pen', key: 'P' }, select: { name: 'Select · IK', key: 'V' }, erase: { name: 'Erase stroke', key: 'E' },
  brush: { name: 'Tag brush', key: 'B' }, edit: { name: 'Edit pen', key: 'D' },
};

function toolBlock(s: HelpState): Block {
  const t = TOOL[s.tool], flat = s.view === 'sketch' || s.view === 'tile';
  switch (s.tool) {
    case 'pen':
      return s.view === 'sketch'
        ? { title: t.name, key: t.key, rows: [['Draw', 'head circle, spine, a tick from the head centre (facing), arms, legs; lift between strokes'], ['Draw apart', 'a new figure: once it has a head and a spine it is a new character, standing where you drew it'], ['M · A', 'mirror · faces away'], ['Ctrl Z · Ctrl Y', 'undo · redo']], note: 'Strokes are tagged automatically. To fix one, V and click it (1–9 retag).' }
        : { title: t.name, key: t.key, rows: [], note: 'New figures are drawn in the front sketch. Here: D reshapes, V selects and drags.' };
    case 'select': {
      const rows: Row[] = [['Click bone', 'select it'], ['Drag bone', 'IK: the body follows (pin with K what should hold)'], ['G', 'whole character: move / turn' + (s.view === '3d' ? ' (or click its ◆)' : '')]];
      if ((s.characters || 1) > 1) rows.push(['Click another', 'switch character'], ['[ · ]', 'previous · next character']);
      if (s.view === '3d') rows.push(['Click an object', 'select it (drag: slide it on the floor)']);
      rows.push(['R · Shift R', 'reach to · reach and attach'], ['K · Shift K', 'pin part · lock character']);
      if (s.view === 'sketch') rows.push(['Click stroke', 'retag it (1–9, 0 ignore)']);
      return { title: t.name, key: t.key, rows };
    }
    case 'erase':
      return { title: t.name, key: t.key, rows: s.view === 'sketch' ? [['Click · drag', 'delete strokes under the pointer']] : [], note: s.view === 'sketch' ? undefined : 'Erase works in the front sketch.' };
    case 'brush':
      return { title: t.name, key: t.key, rows: s.view === 'sketch' ? [['Draw', 'a stroke with the chosen tag'], ['1–9', 'pick the tag']] : [], note: s.view === 'sketch' ? 'It replaces the stroke that held that tag.' : 'The brush works in the front sketch.' };
    case 'edit': {
      const rows: Row[] = [['Draw over a part', 'its new shape'], ['Click a part', 'pick it first'], ['Shift', 'snap to 15°']];
      if (!flat) rows.push(['Right-drag', 'orbit']);
      return { title: t.name, key: t.key, rows, note: 'Each guide is a draft: Enter keeps it, Esc rolls it back.' };
    }
  }
}

/** What is happening right now, if anything (shown above the tool's basics). */
function contextBlock(s: HelpState): Block | null {
  if (s.reaching) {
    const w = s.reaching.what;
    return { title: s.reaching.attach ? `Attach the ${w}` : `Reach with the ${w}`, rows: [['Click a point', `on any character, in any view (objects: in 3D): the ${w} goes there${s.reaching.attach ? ' and stays' : ''}`], ['Esc', 'cancel']] };
  }
  if (s.view === 'scene') return { title: 'Scene view', rows: [['Drag ◆', 'move that character'], ['Click a character', 'make it the active one']] };
  if (s.obj && s.tool === 'select') {
    const rows: Row[] = s.view === '3d'
      ? [['Drag it', 'slide it on the floor'], ['Rings', 'turn (Shift 15°)'], ['Arrows', 'move along an axis'], ['Up · Down', 'lift · lower 5 cm (Shift 1 cm)'], ['R', 'attach it to a character (click where)'], ['K', 'lock · unlock it'], ['Delete', 'delete it'], ['F · Esc', 'focus · done']]
      : [['3D view', 'drag it, or its gizmo: rings turn, arrows and the square move'], ['Up · Down', 'lift · lower 5 cm (Shift 1 cm)'], ['Esc', 'done']];
    if (s.obj.picking) return { title: `Attach ${s.obj.name}`, rows: [['Click a character', 'in 3D: it goes there and follows that bone'], ['Esc', 'cancel']] };
    return { title: s.obj.name, rows, note: s.obj.locked ? 'Locked: unlock it (Pose card) to move it.' : 'Its numbers and scale are in the Pose card, its colour and look in Colour & look.' };
  }
  if (s.pending && s.view === 'sketch' && s.tool === 'pen') return { title: 'New figure', rows: [['Head and spine', 'it becomes a new character'], ['Erase · Ctrl Z', 'drop it']] };
  if (s.drafts) {
    const rows: Row[] = [['Enter', s.drafts > 1 ? 'apply all' : 'apply'], ['Esc', 'discard the last'], ['Draw again', 'redo that part']];
    if (s.altPart) rows.push(['Tab', `meant ${s.altPart}`]);
    return { title: s.drafts > 1 ? `${s.drafts} drafts` : 'Draft', rows };
  }
  if (s.rootSel && s.tool === 'select') {
    const rows: Row[] = s.view === '3d'
      ? [['Rings', 'turn (Shift 15°)'], ['Arrows', 'move along an axis'], ['Square', 'slide on the floor (Shift 5 cm)'], ['Up · Down', 'lift · lower 5 cm (Shift 1 cm)'], ['Esc', 'done']]
      : [['3D view', 'its gizmo: rings turn, arrows and the square move'], ['Up · Down', 'lift · lower 5 cm (Shift 1 cm)'], ['Esc', 'done']];
    return { title: 'Whole character', rows, note: s.locked ? 'Locked: Shift K unlocks it.' : undefined };
  }
  if (s.bone && s.tool === 'select') {
    const b = s.bone;
    if (b.pinned || s.locked) return { title: b.name, rows: [[s.locked ? 'Shift K' : 'K', s.locked ? 'unlock the character' : `unpin ${b.part}`]], note: s.locked ? 'Locked: nothing changes.' : 'Pinned: it holds still and ignores edits.' };
    const rows: Row[] = [['Rings', 'turn about that axis (Shift 15°)'], ['Ball', 'point this bone only'], ['Drag the bone', 'IK: the body follows'], ['Arrows', 'nudge 5° (Shift 1°)'], ['K', `pin ${b.part}`]];
    if (b.limb) rows.push(['R · Shift R', 'reach to · attach'], ['C', 'copy to the other side']);
    if (s.contacts) rows.push(['Edit by hand', 'detaches an attached limb']);
    rows.push(['Drag a number', 'in the Pose card changes it (Shift: finer)']);
    return { title: b.name, rows };
  }
  if (s.target && s.tool === 'edit') return { title: s.target, rows: [['Draw', 'its new shape anywhere in this view'], ['Esc', 'pick another part']] };
  return null;
}

const NAV: Record<HelpView, string> = {
  sketch: 'Wheel zoom · right-drag or Space + drag pan',
  tile: 'Wheel zoom · right-drag or Space + drag pan',
  scene: 'Wheel zoom · right-drag pan',
  '3d': 'Drag empty space orbit · right-drag pan · wheel zoom',
};

const esc = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
/** Keys like "R · Shift R" become key chips; actions ("Drag bone") stay words. */
function keys(k: string): string {
  const isKey = (p: string) => /^((Shift|Ctrl) )?([A-Z0-9]|1–9|\[ \])$|^(Esc|Enter|Tab|Shift|Up|Down|Delete)$|^Ctrl [A-Z]$/.test(p);
  return k.split(' · ').map(p => isKey(p) ? `<kbd>${esc(p)}</kbd>` : `<span>${esc(p)}</span>`).join('<i>·</i>');
}
function block(b: Block, main: boolean): string {
  const head = `<div class="hh${main ? '' : ' sub'}"><b>${esc(b.title)}</b>${b.key ? `<kbd>${b.key}</kbd>` : ''}</div>`;
  const rows = b.rows.length ? `<dl>${b.rows.map(([k, v]) => `<dt>${keys(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
  return head + rows + (b.note ? `<p>${esc(b.note)}</p>` : '');
}
/** The help box's content for a state (HTML). */
export function helpHTML(s: HelpState): string {
  const ctx = contextBlock(s), tool = toolBlock(s);
  let html = '';
  if (ctx) {
    html += block(ctx, true);
    // the tool's own basics follow, folded to its name and key (the context already lists what matters)
    html += `<div class="hh sub tool"><span>Tool</span><b>${esc(tool.title)}</b><kbd>${tool.key}</kbd></div>`;
  } else html += block(tool, true);
  if (s.locked && !s.obj && !(ctx && ctx.note)) html += `<p class="warn">Character locked: Shift K unlocks it.</p>`;
  html += `<div class="nav">${esc(NAV[s.view])}</div>`;
  return html;
}
