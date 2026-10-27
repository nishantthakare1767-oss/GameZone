/** All timestamps in the system come from this clock (UTC), never from the browser. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FakeClock extends Clock {
  advance(ms: number): void;
  advanceMinutes(minutes: number): void;
  set(date: Date): void;
}

export function createFakeClock(start: Date = new Date('2026-01-01T09:00:00.000Z')): FakeClock {
  let current = new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    advanceMinutes(minutes: number) {
      current = new Date(current.getTime() + minutes * 60_000);
    },
    set(date: Date) {
      current = new Date(date.getTime());
    },
  };
}

export const minutesToMs = (minutes: number) => minutes * 60_000;
export const addMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutesToMs(minutes));
export const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);
