import { ROSTER } from '../core/config';
import type { AgentLook } from './look';

/*
 * Presentation-only identities. Custom agents change names, colours and models in
 * the renderer and HUD; the simulation, SDK state and replays never see them, so
 * determinism and the replay format are unaffected.
 */
export interface ActorIdentity {
  name: string;
  color: string;
  look: AgentLook | null;
}

const assigned = new Map<number, AgentLook>();
let revision = 0;

/** Replaces every custom identity; `null` entries fall back to the default roster. */
export function assignAgents(looks: ReadonlyMap<number, AgentLook | null>): void {
  assigned.clear();
  for (const [actorId, look] of looks) if (look) assigned.set(actorId, look);
  revision++;
}

export function clearAgents(): void {
  if (!assigned.size) return;
  assigned.clear();
  revision++;
}

/** Increments whenever assignments change, so views can rebuild cached visuals. */
export const agentRevision = (): number => revision;

export function actorIdentity(actorId: number): ActorIdentity {
  const look = assigned.get(actorId) ?? null;
  const profile = ROSTER[actorId] ?? ROSTER[0];
  return look
    ? { name: look.name, color: look.hue, look }
    : { name: profile?.name ?? '环境', color: profile?.color ?? '#fff2c5', look: null };
}

export const actorName = (actorId: number): string =>
  ROSTER[actorId] || assigned.has(actorId) ? actorIdentity(actorId).name : '环境';
export const actorColor = (actorId: number): string => actorIdentity(actorId).color;
export const actorLook = (actorId: number): AgentLook | null => assigned.get(actorId) ?? null;
/** One-character token for score cards: the agent's first glyph. */
export function actorToken(actorId: number): string {
  const look = assigned.get(actorId);
  if (look) return [...look.name][0] ?? 'A';
  return [...(ROSTER[actorId]?.name ?? '?')][0];
}
