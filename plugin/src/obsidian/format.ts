/**
 * Sizes, as a person reads them.
 *
 * One decimal place and always MiB: a list where one row says `0.9 MiB` and the next `1.1 MiB` is
 * comparable at a glance, and one that switches to GiB partway down is not. The console makes the same
 * choice for the same reason.
 */
export const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
