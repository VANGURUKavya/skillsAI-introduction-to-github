/**
 * Log File Comparison App
 * Provides side-by-side diff of two plain-text log files.
 */

/**
 * Minimum fraction of the shorter line that must match as a common prefix for
 * two lines to be treated as a modification rather than a separate removal +
 * addition.  40 % works well for structured log lines that share a timestamp
 * or fixed-width severity prefix; lower values produce too many false
 * "changed" pairings for unrelated lines.
 */
const SIMILARITY_THRESHOLD = 0.4;

/* ── State ────────────────────────────────────────────── */
const state = {
  leftText: null,
  rightText: null,
  leftName: 'Log A',
  rightName: 'Log B',
};

/* ── DOM refs ─────────────────────────────────────────── */
const dropLeft    = document.getElementById('drop-left');
const dropRight   = document.getElementById('drop-right');
const btnCompare  = document.getElementById('btn-compare');
const btnClear    = document.getElementById('btn-clear');
const filterSel   = document.getElementById('filter-select');
const statsBar    = document.getElementById('stats-bar');
const diffWrapper = document.getElementById('diff-wrapper');

/* ── File loading ─────────────────────────────────────── */
function setupDrop(dropEl, side) {
  const input = dropEl.querySelector('input[type="file"]');

  input.addEventListener('change', () => {
    if (input.files.length) loadFile(input.files[0], side);
  });

  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropEl.classList.add('drag-over');
  });

  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag-over'));

  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file, side);
  });
}

function loadFile(file, side) {
  const reader = new FileReader();
  reader.onload = (e) => {
    if (side === 'left') {
      state.leftText = e.target.result;
      state.leftName = file.name;
      setFileLoaded(dropLeft, file.name);
    } else {
      state.rightText = e.target.result;
      state.rightName = file.name;
      setFileLoaded(dropRight, file.name);
    }
    updateButtons();
  };
  reader.readAsText(file);
}

function setFileLoaded(dropEl, name) {
  dropEl.classList.add('has-file');
  const nameEl = dropEl.querySelector('.file-name');
  if (nameEl) nameEl.textContent = name;
  const labelEl = dropEl.querySelector('.drop-label');
  if (labelEl) labelEl.textContent = 'File loaded';
}

function updateButtons() {
  btnCompare.disabled = !(state.leftText !== null && state.rightText !== null);
}

/* ── Diff algorithm ───────────────────────────────────── */
/**
 * Compute an LCS-based line diff between two arrays of strings.
 * Returns an array of { type: 'same'|'added'|'removed'|'changed', left, right, leftNum, rightNum }
 */
function diffLines(leftLines, rightLines) {
  // Build LCS table (patience-like: match identical lines)
  const m = leftLines.length;
  const n = rightLines.length;

  // For large files use a simplified approach to stay fast
  if (m * n > 4_000_000) {
    return simpleDiff(leftLines, rightLines);
  }

  // Standard DP LCS
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (leftLines[i] === rightLines[j]) {
        dp[i * (n + 1) + j] = dp[(i + 1) * (n + 1) + (j + 1)] + 1;
      } else {
        dp[i * (n + 1) + j] = Math.max(
          dp[(i + 1) * (n + 1) + j],
          dp[i * (n + 1) + (j + 1)]
        );
      }
    }
  }

  // Traceback
  const ops = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && leftLines[i] === rightLines[j]) {
      ops.push({ type: 'same', left: leftLines[i], right: rightLines[j], leftNum: i + 1, rightNum: j + 1 });
      i++; j++;
    } else if (i < m && (j >= n || dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + (j + 1)])) {
      // Emit removals before additions so consecutive removed+added pairs are recognised as 'changed'
      ops.push({ type: 'removed', left: leftLines[i], right: null, leftNum: i + 1, rightNum: null });
      i++;
    } else {
      ops.push({ type: 'added', left: null, right: rightLines[j], leftNum: null, rightNum: j + 1 });
      j++;
    }
  }

  // Pair consecutive removed+added as 'changed'
  return pairChanges(ops);
}

function simpleDiff(leftLines, rightLines) {
  const ops = [];
  const maxLen = Math.max(leftLines.length, rightLines.length);
  for (let k = 0; k < maxLen; k++) {
    const l = leftLines[k] ?? null;
    const r = rightLines[k] ?? null;
    if (l === null) {
      ops.push({ type: 'added',   left: null, right: r, leftNum: null, rightNum: k + 1 });
    } else if (r === null) {
      ops.push({ type: 'removed', left: l, right: null, leftNum: k + 1, rightNum: null });
    } else if (l === r) {
      ops.push({ type: 'same',    left: l, right: r, leftNum: k + 1, rightNum: k + 1 });
    } else {
      ops.push({ type: 'changed', left: l, right: r, leftNum: k + 1, rightNum: k + 1 });
    }
  }
  return ops;
}

/**
 * Pair consecutive blocks of removed + added ops into 'changed' ops where the
 * lines are similar.  Handles the common case where the LCS traceback emits a
 * run of removals followed by a run of additions for the same changed region.
 */
function pairChanges(ops) {
  const result = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== 'removed') {
      result.push(ops[i++]);
      continue;
    }
    // Collect a contiguous block of removals
    let j = i;
    while (j < ops.length && ops[j].type === 'removed') j++;
    // Collect a contiguous block of additions immediately after
    let k = j;
    while (k < ops.length && ops[k].type === 'added') k++;

    const removals = ops.slice(i, j);
    const additions = ops.slice(j, k);

    // Pair each removal with the addition at the same position if similar
    const paired = new Array(removals.length).fill(false);
    const usedAdd = new Array(additions.length).fill(false);

    removals.forEach((rem, ri) => {
      const ai = ri; // prefer same-index partner first
      if (ai < additions.length && !usedAdd[ai] && isSimilar(rem.left, additions[ai].right)) {
        result.push({
          type: 'changed',
          left: rem.left,
          right: additions[ai].right,
          leftNum: rem.leftNum,
          rightNum: additions[ai].rightNum,
        });
        paired[ri] = true;
        usedAdd[ai] = true;
      }
    });

    // Emit unpaired removals and additions as-is
    removals.forEach((rem, ri)  => { if (!paired[ri])   result.push(rem); });
    additions.forEach((add, ai) => { if (!usedAdd[ai])  result.push(add); });

    i = k;
  }
  return result;
}

/**
 * Returns true when two strings are similar enough to be shown as a modification
 * rather than an independent removal + addition.
 * Heuristic: the lines share at least SIMILARITY_THRESHOLD of the shorter line
 * as a common prefix. This works well for log files that share timestamps or
 * structured prefixes.
 */
function isSimilar(a, b) {
  if (!a || !b) return false;
  const shorter = Math.min(a.length, b.length);
  if (shorter === 0) return false;
  let prefix = 0;
  while (prefix < shorter && a[prefix] === b[prefix]) prefix++;
  return prefix / shorter >= SIMILARITY_THRESHOLD;
}

/* ── Inline character diff ────────────────────────────── */
function charDiff(a, b) {
  // Simple character-level LCS for short lines
  if (a.length + b.length > 2000) {
    return { left: esc(a), right: esc(b) };
  }

  const m = a.length, n = b.length;
  const dp = new Uint16Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (n + 1) + (j + 1)] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + (j + 1)]);
    }
  }

  let leftHtml = '', rightHtml = '';
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      leftHtml  += esc(a[i]);
      rightHtml += esc(b[j]);
      i++; j++;
    } else if (j < n && (i >= m || dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + (j + 1)])) {
      rightHtml += `<mark class="ins">${esc(b[j])}</mark>`;
      j++;
    } else {
      leftHtml += `<mark class="del">${esc(a[i])}</mark>`;
      i++;
    }
  }
  return { left: leftHtml, right: rightHtml };
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ── Render ───────────────────────────────────────────── */
function renderDiff(ops, filter) {
  const counts = { added: 0, removed: 0, changed: 0, same: 0 };
  ops.forEach((op) => counts[op.type]++);

  // Stats bar
  statsBar.innerHTML = `
    <div class="stat-pill"><span class="dot dot-added"></span>${counts.added} added</div>
    <div class="stat-pill"><span class="dot dot-removed"></span>${counts.removed} removed</div>
    <div class="stat-pill"><span class="dot dot-changed"></span>${counts.changed} changed</div>
    <div class="stat-pill"><span class="dot dot-same"></span>${counts.same} same</div>
  `;
  statsBar.style.display = 'flex';

  // Diff header
  const header = `
    <div class="diff-header">
      <div class="diff-header-cell">📄 ${esc(state.leftName)}</div>
      <div class="diff-header-cell">📄 ${esc(state.rightName)}</div>
    </div>`;

  // Rows
  let rowsHtml = '';
  ops.forEach((op) => {
    if (filter !== 'all' && op.type !== filter) return;

    let rowClass = `row-${op.type}`;
    let leftNumHtml  = op.leftNum  ? op.leftNum  : '';
    let rightNumHtml = op.rightNum ? op.rightNum : '';
    let leftCellClass  = '';
    let rightCellClass = '';
    let leftContent  = '';
    let rightContent = '';

    if (op.type === 'same') {
      leftContent  = esc(op.left);
      rightContent = esc(op.right);
    } else if (op.type === 'added') {
      leftCellClass  = '';
      rightCellClass = 'cell-added';
      leftContent  = '';
      rightContent = esc(op.right);
      rowClass = 'row-added';
    } else if (op.type === 'removed') {
      leftCellClass  = 'cell-removed';
      rightCellClass = '';
      leftContent  = esc(op.left);
      rightContent = '';
      rowClass = 'row-removed';
    } else if (op.type === 'changed') {
      leftCellClass  = 'cell-changed-left';
      rightCellClass = 'cell-changed-right';
      const inlined = charDiff(op.left, op.right);
      leftContent  = inlined.left;
      rightContent = inlined.right;
      rowClass = 'row-changed';
    }

    rowsHtml += `
      <tr class="${rowClass}">
        <td class="line-num">${leftNumHtml}</td>
        <td class="line-content ${leftCellClass}">${leftContent}</td>
        <td class="line-num">${rightNumHtml}</td>
        <td class="line-content ${rightCellClass}">${rightContent}</td>
      </tr>`;
  });

  if (!rowsHtml) {
    rowsHtml = `<tr><td colspan="4" style="text-align:center;padding:2rem;color:#8b949e;">
      No lines match the selected filter.
    </td></tr>`;
  }

  diffWrapper.innerHTML = `
    ${header}
    <div class="diff-scroll">
      <table class="diff-table">
        <colgroup>
          <col><col><col><col>
        </colgroup>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

/* ── Compare handler ──────────────────────────────────── */
function runCompare() {
  const leftLines  = state.leftText.split('\n');
  const rightLines = state.rightText.split('\n');

  // Strip trailing empty line if both end with one (common artifact)
  if (leftLines.at(-1)  === '') leftLines.pop();
  if (rightLines.at(-1) === '') rightLines.pop();

  const ops = diffLines(leftLines, rightLines);
  state.ops = ops;
  renderDiff(ops, filterSel.value);
}

/* ── Clear handler ────────────────────────────────────── */
function runClear() {
  state.leftText  = null;
  state.rightText = null;
  state.leftName  = 'Log A';
  state.rightName = 'Log B';
  state.ops       = null;

  [dropLeft, dropRight].forEach((el) => {
    el.classList.remove('has-file');
    el.querySelector('.drop-label').textContent = 'Drop a log file here or click to browse';
    el.querySelector('.file-name').textContent  = '';
    el.querySelector('input[type="file"]').value = '';
  });

  statsBar.style.display = 'none';

  diffWrapper.innerHTML = `
    <div class="empty-state">
      <div class="big-icon">📋</div>
      <p>Load two log files above and click <strong>Compare</strong> to see the differences.</p>
    </div>`;

  updateButtons();
}

/* ── Filter change ────────────────────────────────────── */
filterSel.addEventListener('change', () => {
  if (state.ops) renderDiff(state.ops, filterSel.value);
});

/* ── Boot ─────────────────────────────────────────────── */
setupDrop(dropLeft,  'left');
setupDrop(dropRight, 'right');
btnCompare.addEventListener('click', runCompare);
btnClear.addEventListener('click', runClear);
updateButtons();
