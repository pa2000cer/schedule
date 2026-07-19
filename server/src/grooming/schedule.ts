/**
 * Grooming routine schedule module.
 * Extracts weekly grooming tasks for any given date, with biweekly logic for Saturday feet care.
 */

/**
 * A single grooming task with time, title, and optional note.
 */
export interface GroomingTask {
  time: string;
  title: string;
  note?: string;
  period: "AM" | "PM";
}

/**
 * Raw weekly schedule data structure (day → sections → items).
 * Exported for reuse by other tasks/modules.
 */
interface ScheduleItem {
  t: string;
  title: string;
  note?: string;
  biweekly?: boolean;
}

interface ScheduleSection {
  label: string;
  items: ScheduleItem[];
}

export const schedule: Record<string, ScheduleSection[]> = {
  Sunday: [
    {
      label: "AM",
      items: [
        { t: "6:30 AM", title: "Daily skincare", note: "cleanse, moisturize, SPF" },
        { t: "6:40 AM", title: "Shave head" },
        { t: "6:45 AM", title: "Shave face, nose & ears" },
        { t: "7:00 AM", title: "Pluck eyebrows" },
      ],
    },
    {
      label: "PM",
      items: [
        { t: "8:30 PM", title: "Shave body" },
        { t: "9:30 PM", title: "Daily skincare", note: "cleanse, moisturize" },
      ],
    },
  ],
  Monday: [
    {
      label: "AM",
      items: [
        { t: "6:30 AM", title: "Daily skincare" },
        { t: "6:40 AM", title: "Shave head" },
        { t: "6:45 AM", title: "Shave face, nose & ears" },
      ],
    },
    {
      label: "PM",
      items: [
        { t: "9:00 PM", title: "Whiten teeth" },
        { t: "9:30 PM", title: "Daily skincare" },
      ],
    },
  ],
  Tuesday: [
    {
      label: "AM",
      items: [
        { t: "6:30 AM", title: "Daily skincare" },
        { t: "6:40 AM", title: "Shave head" },
        { t: "6:45 AM", title: "Shave face, nose & ears" },
      ],
    },
    {
      label: "PM",
      items: [
        { t: "8:00 PM", title: "Facial", note: "steam, mask, wash" },
        { t: "9:30 PM", title: "Daily skincare" },
      ],
    },
  ],
  Wednesday: [
    {
      label: "AM",
      items: [
        { t: "6:30 AM", title: "Daily skincare" },
        { t: "6:40 AM", title: "Shave head" },
        { t: "6:45 AM", title: "Shave face, nose & ears" },
      ],
    },
    {
      label: "PM",
      items: [
        { t: "8:30 PM", title: "Shave body" },
        { t: "9:30 PM", title: "Daily skincare" },
      ],
    },
  ],
  Thursday: [
    {
      label: "AM",
      items: [
        { t: "6:30 AM", title: "Daily skincare" },
        { t: "6:40 AM", title: "Shave head" },
        { t: "6:45 AM", title: "Shave face, nose & ears" },
      ],
    },
    {
      label: "PM",
      items: [{ t: "9:30 PM", title: "Daily skincare" }],
    },
  ],
  Friday: [
    {
      label: "AM",
      items: [
        { t: "6:30 AM", title: "Daily skincare" },
        { t: "6:40 AM", title: "Shave head" },
        { t: "6:45 AM", title: "Shave face, nose & ears" },
      ],
    },
    {
      label: "PM",
      items: [
        { t: "8:00 PM", title: "Facial", note: "steam, mask, wash" },
        { t: "9:30 PM", title: "Daily skincare" },
      ],
    },
  ],
  Saturday: [
    {
      label: "AM",
      items: [
        { t: "6:30 AM", title: "Daily skincare" },
        { t: "6:40 AM", title: "Shave head" },
        { t: "6:45 AM", title: "Shave face, nose & ears" },
        { t: "8:00 AM", title: "Tend to feet", note: "1st & 3rd Saturday only", biweekly: true },
      ],
    },
    {
      label: "PM",
      items: [{ t: "9:30 PM", title: "Daily skincare" }],
    },
  ],
};

/**
 * Parse time string to extract hour and AM/PM.
 * @param timeStr e.g. "6:30 AM" or "8:00 PM"
 * @returns { hours: number, minutes: number, period: "AM" | "PM" }
 */
function parseTime(timeStr: string): {
  hours: number;
  minutes: number;
  period: "AM" | "PM";
} {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) {
    throw new Error(`Invalid time format: ${timeStr}`);
  }
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = (match[3].toUpperCase() as "AM" | "PM");
  return { hours, minutes, period };
}

/**
 * Compare two times for sorting.
 * Sorts AM before PM, then chronologically within each period.
 */
function compareTime(timeA: string, timeB: string): number {
  const a = parseTime(timeA);
  const b = parseTime(timeB);

  // AM (0) before PM (1)
  if (a.period === "AM" && b.period === "PM") return -1;
  if (a.period === "PM" && b.period === "AM") return 1;

  // Both same period: sort by hour then minutes
  if (a.hours !== b.hours) return a.hours - b.hours;
  return a.minutes - b.minutes;
}

/**
 * Get all grooming tasks for a given date.
 * Handles biweekly logic for Saturday "Tend to feet" (1st & 3rd Saturday only).
 *
 * @param date The date to get tasks for (uses local date components)
 * @returns Array of GroomingTask sorted by time (AM before PM, chronological)
 */
export function getGroomingTasks(date: Date): GroomingTask[] {
  const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const dayOfMonth = date.getDate();

  // Map dayOfWeek (0-6) to day name
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const dayName = dayNames[dayOfWeek];

  // Get the schedule sections for this day
  const daySections = schedule[dayName];
  if (!daySections) {
    throw new Error(`No schedule for day: ${dayName}`);
  }

  // Collect all items for this day
  const tasks: GroomingTask[] = [];

  for (const section of daySections) {
    for (const item of section.items) {
      // Check biweekly rule for Saturday "Tend to feet"
      if (item.biweekly) {
        if (dayOfWeek !== 6) {
          // Not Saturday
          continue;
        }
        // Compute ordinal within month: ceil(dayOfMonth / 7)
        const saturdayOrdinal = Math.ceil(dayOfMonth / 7);
        // Only include if 1st or 3rd Saturday
        if (saturdayOrdinal !== 1 && saturdayOrdinal !== 3) {
          continue;
        }
      }

      // Parse period from time string
      const { period } = parseTime(item.t);

      tasks.push({
        time: item.t,
        title: item.title,
        note: item.note,
        period,
      });
    }
  }

  // Sort by time (AM before PM, then chronological)
  tasks.sort((a, b) => compareTime(a.time, b.time));

  return tasks;
}
