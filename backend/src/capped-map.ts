/**
 * Set a key in a session cache that must not grow for ever: a re-set key moves
 * to the newest place, and the oldest entry goes once the map passes `max`.
 */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}
