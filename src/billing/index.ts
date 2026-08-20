/**
 * How the developer pays for each agent, detected from its own local auth
 * state. A turn priced under the wrong arrangement is worse than one that
 * admits it does not know, so only positively recognized states are reported.
 */
export { detectBillingMode } from './billing-mode.js';
