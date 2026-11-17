import type { DesktopLocale } from "./i18n.js";
import type { NotificationLevel } from "../notifications/notification-service.js";

export interface NotificationCard {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  ts: string;
  sessionTitle: string;
  hasSession: boolean;
  count: number;
  locale: DesktopLocale;
}

export interface NotificationCardApi {
  current(): Promise<NotificationCard | null>;
  act(action: "open" | "dismiss" | "pause" | "resume", id: string): Promise<void>;
  subscribe(listener: (card: NotificationCard) => void): () => void;
}
