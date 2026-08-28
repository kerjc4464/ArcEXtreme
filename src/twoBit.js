// 2bit饱和计数器：0强拒绝/1弱拒绝/2弱接纳/3强接纳
import { translateCounter } from './config.js';

export const COUNTER_MIN = 0;
export const COUNTER_MAX = 3;

export function clampCounter(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 2;
    return Math.max(0, Math.min(3, Math.round(v)));
}

export function applyAction(counter, action) {
    const c = clampCounter(counter);
    if (action === '+1') return Math.min(3, c + 1);
    if (action === '-1') return Math.max(0, c - 1);
    return c; // Skip
}

export function isStrong(counter) {
    const c = clampCounter(counter);
    return c === 0 || c === 3;
}

export function nextSkip(curSkip, action) {
    if (action === 'Skip') return (Number(curSkip) || 0) + 1;
    return 0;
}

export function nextStuck(curCounter, nextCounter, curStuck, action) {
    const nc = clampCounter(nextCounter);
    if (nc !== 0 && nc !== 3) return 0;
    // staying at strong state counts as stuck, even on Skip
    if (nc === curCounter) return (Number(curStuck) || 0) + 1;
    // just entered strong
    if (nc === 0 || nc === 3) return 1;
    return 0;
}

export function translate(counter) {
    return translateCounter(counter);
}

export function formatEventWithAttitude(soul, eventText, counter) {
    const att = translate(counter);
    const label = counter === 0 ? '强拒绝' : counter === 1 ? '弱拒绝' : counter === 2 ? '弱接纳' : '强接纳';
    return `【${soul}】${eventText} —— ${att}(${counter}/${label})`;
}
