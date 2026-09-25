import type { JSX, ReactNode } from "react";

export interface IconProps {
  className?: string;
}

function Icon({ className, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="1em"
      height="1em"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconGrid(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </Icon>
  );
}

export function IconPlus(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconPause(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </Icon>
  );
}

export function IconPlay(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M7 4.5v15l13-7.5z" />
    </Icon>
  );
}

export function IconMic(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </Icon>
  );
}

export function IconAudioLines(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2 10v3" />
      <path d="M6 6v11" />
      <path d="M10 3v18" />
      <path d="M14 8v7" />
      <path d="M18 5v13" />
      <path d="M22 10v3" />
    </Icon>
  );
}

export function IconCheckSquare(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function IconLayoutTemplate(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect width="18" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
    </Icon>
  );
}

export function IconSettings(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function IconShield(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </Icon>
  );
}

export function IconUsers(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

export function IconServer(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect width="20" height="8" x="2" y="2" rx="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </Icon>
  );
}

export function IconScrollText(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
    </Icon>
  );
}

export function IconSearch(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  );
}

export function IconFilter(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 6h18" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </Icon>
  );
}

export function IconX(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

export function IconCheck(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function IconLogOut(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </Icon>
  );
}

export function IconSparkles(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M12 3l1.9 5.7a2 2 0 0 0 1.25 1.25L20.85 12l-5.7 1.9a2 2 0 0 0-1.25 1.25L12 20.85l-1.9-5.7a2 2 0 0 0-1.25-1.25L3.15 12l5.7-1.9a2 2 0 0 0 1.25-1.25Z" />
      <path d="M5 3l.6 1.8a1 1 0 0 0 .63.63L8 6l-1.77.57a1 1 0 0 0-.63.63L5 9l-.6-1.8A1 1 0 0 0 3.77 6.6L2 6l1.77-.57a1 1 0 0 0 .63-.63Z" />
    </Icon>
  );
}

export function IconClock(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Icon>
  );
}

export function IconAlertTriangle(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

export function IconArrowUpDown(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m21 16-4 4-4-4" />
      <path d="M17 20V4" />
      <path d="m3 8 4-4 4 4" />
      <path d="M7 4v16" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}

export function IconCalendar(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </Icon>
  );
}

export function IconInbox(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Icon>
  );
}

export function IconDownload(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Icon>
  );
}

export function IconTrash(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  );
}

export function IconPencil(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </Icon>
  );
}

export function IconCpu(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2" />
      <path d="M15 20v2" />
      <path d="M2 15h2" />
      <path d="M2 9h2" />
      <path d="M20 15h2" />
      <path d="M20 9h2" />
      <path d="M9 2v2" />
      <path d="M9 20v2" />
    </Icon>
  );
}

export function IconEye(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function IconEyeOff(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="M2 2l20 20" />
    </Icon>
  );
}

export function IconSpeaker(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect width="16" height="20" x="4" y="2" rx="2" />
      <path d="M12 6h.01" />
      <circle cx="12" cy="14" r="4" />
      <path d="M12 14h.01" />
    </Icon>
  );
}

export function IconZap(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </Icon>
  );
}

export function IconGlobe(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </Icon>
  );
}

export function IconRefresh(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </Icon>
  );
}

export function IconMonitor(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </Icon>
  );
}