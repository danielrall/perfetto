// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {describe, expect, test} from 'vitest';
import {
  getNextPollDelayMs,
  POLL_INTERVAL_FAST_MS,
  POLL_INTERVAL_HIDDEN_MS,
  POLL_INTERVAL_MID_MS,
  POLL_INTERVAL_SLOW_MS,
  POLL_RETRY_BASE_MS,
  POLL_RETRY_MAX_MS,
} from './polling_controller';

describe('getNextPollDelayMs', () => {
  test('returns fast interval (3s) for queries < 30s', () => {
    const now = Date.now();
    expect(getNextPollDelayMs({startTimeMs: now - 5_000})).toBe(
      POLL_INTERVAL_FAST_MS,
    );
    expect(getNextPollDelayMs({startTimeMs: now - 29_000})).toBe(
      POLL_INTERVAL_FAST_MS,
    );
  });

  test('returns mid interval (6s) for queries between 30s and 2m', () => {
    const now = Date.now();
    expect(getNextPollDelayMs({startTimeMs: now - 35_000})).toBe(
      POLL_INTERVAL_MID_MS,
    );
    expect(getNextPollDelayMs({startTimeMs: now - 110_000})).toBe(
      POLL_INTERVAL_MID_MS,
    );
  });

  test('returns slow interval (10s) for long queries > 2m', () => {
    const now = Date.now();
    expect(getNextPollDelayMs({startTimeMs: now - 125_000})).toBe(
      POLL_INTERVAL_SLOW_MS,
    );
    expect(getNextPollDelayMs({startTimeMs: now - 600_000})).toBe(
      POLL_INTERVAL_SLOW_MS,
    );
  });

  test('returns hidden interval (30s) when tab is hidden', () => {
    const now = Date.now();
    expect(getNextPollDelayMs({startTimeMs: now - 5_000, isHidden: true})).toBe(
      POLL_INTERVAL_HIDDEN_MS,
    );
  });

  test('backs off exponentially on consecutive errors up to max retry interval', () => {
    expect(getNextPollDelayMs({consecutiveErrors: 1})).toBe(POLL_RETRY_BASE_MS); // 3s
    expect(getNextPollDelayMs({consecutiveErrors: 2})).toBe(6_000); // 6s
    expect(getNextPollDelayMs({consecutiveErrors: 3})).toBe(12_000); // 12s
    expect(getNextPollDelayMs({consecutiveErrors: 4})).toBe(24_000); // 24s
    expect(getNextPollDelayMs({consecutiveErrors: 5})).toBe(POLL_RETRY_MAX_MS); // 30s
    expect(getNextPollDelayMs({consecutiveErrors: 10})).toBe(POLL_RETRY_MAX_MS); // 30s cap
  });
});
