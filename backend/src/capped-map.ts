/** Sets a key in a session cache that can't grow for ever: a re-set key becomes newest, the oldest goes past `max` */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}
