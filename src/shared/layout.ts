// Pure geometry helpers shared by the views (no DOM, so the tests can import them directly).

/**
 * Places blocks as close to their ideal positions as possible while keeping them in order and
 * non-overlapping — isotonic regression by pool-adjacent-violators, which is the exact minimiser of
 * the total squared displacement. In practice: a cluster settles around its own centre instead of
 * every card being shoved downwards, so the cusps stay short.
 */
export function balancePositions(ideals: number[], heights: number[], gap: number, minTop = 4): number[] {
  const n = ideals.length;
  if (!n) return [];
  const offset: number[] = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    offset[i] = acc;
    acc += heights[i]! + gap;
  }
  // With x_i = top_i - offset_i the no-overlap constraint is just "x is non-decreasing".
  const value: number[] = [];
  const weight: number[] = [];
  const count: number[] = [];
  for (let i = 0; i < n; i += 1) {
    value.push(ideals[i]! - offset[i]!);
    weight.push(1);
    count.push(1);
    while (value.length > 1 && value[value.length - 2]! > value[value.length - 1]!) {
      const v2 = value.pop()!, w2 = weight.pop()!, c2 = count.pop()!;
      const v1 = value.pop()!, w1 = weight.pop()!, c1 = count.pop()!;
      value.push((v1 * w1 + v2 * w2) / (w1 + w2));
      weight.push(w1 + w2);
      count.push(c1 + c2);
    }
  }
  const tops: number[] = [];
  let k = 0;
  for (let b = 0; b < value.length; b += 1) {
    for (let j = 0; j < count[b]!; j += 1) {
      tops.push(value[b]! + offset[k]!);
      k += 1;
    }
  }
  // Keep the first block on screen without disturbing the rest more than necessary.
  let floor = minTop;
  for (let i = 0; i < n; i += 1) {
    tops[i] = Math.max(tops[i]!, floor);
    floor = tops[i]! + heights[i]! + gap;
  }
  return tops;
}
