import type { SESSION_BASELINE } from '../constants/session-baseline.constant';

/** Базовая линия уборки сессии (`SESSION_BASELINE`). */
export type SessionBaseline = (typeof SESSION_BASELINE)[keyof typeof SESSION_BASELINE];
