export type { Options, Plugin, Result, Service } from './useRequest/src/types';
export { default as useDeeplinkHandler } from './useDeeplinkHandler';
export { default as useHistoryTravel } from './useHistoryTravel';
export { default as useMount } from './useMount';
export {
  CancelledError,
  clearCache,
  isCancelledError,
  default as useRequest,
} from './useRequest';
export { default as useWhyDidYouUpdate } from './useWhyDidYouUpdate';
