/** Общая логика разбора сцены для rehearsal.js и result.js */

export function extractSpeakable(text) {
  return text
    .replace(/\[\[.*?\]\]/g, '')
    .replace(/\[(?!\[).*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * См. rehearsal.js: подряд идущие реплики не актёра → один шаг partner;
 * реплика актёра → шаг actor.
 */
export function buildSequence(blocks, role) {
  const seq = [];
  let partnerLines = [];
  let partnerSegId = 0;

  for (const block of blocks) {
    if (block.role === 'annotation') continue;

    if (block.role === role) {
      if (partnerLines.length > 0) {
        seq.push({ type: 'partner', segId: partnerSegId++, lines: [...partnerLines] });
        partnerLines = [];
      }
      seq.push({ type: 'actor', line: block });
    } else {
      partnerLines.push(block);
    }
  }

  if (partnerLines.length > 0) {
    seq.push({ type: 'partner', segId: partnerSegId, lines: [...partnerLines] });
  }

  return seq;
}
