import type { CLIENT_MISUSE } from '../constants/client-misuse.constant';

export type ClientMisuse = (typeof CLIENT_MISUSE)[keyof typeof CLIENT_MISUSE];
