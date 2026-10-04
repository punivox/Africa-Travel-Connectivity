/**
 * Trip data estimate for calculate_safari_data. The per-activity rates are
 * typical app figures, not measurements: real usage depends on the apps, video
 * quality and network. Every estimate returns the rates it used.
 */

export const RATES = {
  messaging_minutes: { mb: 0.2, unit: "minute", label: "Messaging (text and voice notes)" },
  maps_minutes: { mb: 0.1, unit: "minute", label: "Maps and navigation" },
  web_minutes: { mb: 1, unit: "minute", label: "Web browsing" },
  social_media_minutes: { mb: 2.5, unit: "minute", label: "Social media feeds" },
  video_call_minutes: { mb: 6, unit: "minute", label: "Video calls" },
  streaming_minutes: { mb: 12, unit: "minute", label: "Video streaming (mobile quality)" },
  photos_uploaded: { mb: 3, unit: "photo", label: "Photo uploads (full resolution)" },
} as const;

export type Activity = keyof typeof RATES;
export type Profile = "light" | "moderate" | "heavy";

/** Daily amounts per profile: light = messages and maps, heavy = video and streaming. */
export const PROFILES: Record<Profile, Record<Activity, number>> = {
  light: {
    messaging_minutes: 60, maps_minutes: 15, web_minutes: 15, social_media_minutes: 15,
    video_call_minutes: 0, streaming_minutes: 0, photos_uploaded: 5,
  },
  moderate: {
    messaging_minutes: 90, maps_minutes: 30, web_minutes: 30, social_media_minutes: 45,
    video_call_minutes: 10, streaming_minutes: 0, photos_uploaded: 20,
  },
  heavy: {
    messaging_minutes: 120, maps_minutes: 45, web_minutes: 45, social_media_minutes: 90,
    video_call_minutes: 30, streaming_minutes: 45, photos_uploaded: 40,
  },
};

/** App updates, sync and OS traffic on top of the listed activities. */
export const BACKGROUND_SHARE = 0.1;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Estimate {
  daily_mb: number;
  total_gb: number;
  breakdown: { activity: string; amount_per_day: number; unit: string; mb_per_day: number }[];
}

export function estimateData(
  days: number,
  profile: Profile,
  overrides: Partial<Record<Activity, number>>,
  devices: number,
): Estimate {
  const usage = { ...PROFILES[profile], ...overrides };
  const breakdown = (Object.keys(RATES) as Activity[])
    .filter((a) => usage[a] > 0)
    .map((a) => ({
      activity: RATES[a].label,
      amount_per_day: usage[a],
      unit: RATES[a].unit,
      mb_per_day: round1(usage[a] * RATES[a].mb * devices),
    }));
  const listed = breakdown.reduce((sum, b) => sum + b.mb_per_day, 0);
  const daily = Math.round(listed * (1 + BACKGROUND_SHARE));
  return { daily_mb: daily, total_gb: round2((daily * days) / 1024), breakdown };
}

export const ASSUMPTIONS =
  "Typical app data rates (MB): messaging 0.2/min, maps 0.1/min, web 1/min, social media 2.5/min, " +
  "video calls 6/min, streaming 12/min, 3 per uploaded photo, plus 10% background traffic, multiplied by " +
  "the number of devices sharing the connection. Real usage varies with apps, video quality and network.";
