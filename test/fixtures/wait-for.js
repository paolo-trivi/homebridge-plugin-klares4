'use strict';

/**
 * Polls `predicate` until it holds. Matter registration and recovery run on
 * timers, so a fixed delay is not enough on a slow CI runner: tests wait for
 * the outcome and fail only when it never comes.
 */
async function waitFor(predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

module.exports = { waitFor };
