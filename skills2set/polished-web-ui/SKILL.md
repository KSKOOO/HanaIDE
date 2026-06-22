---
name: polished-web-ui
description: Use when creating or modifying frontend code for polished web UIs, single-file HTML/CSS/JavaScript, responsive pages, apps, dashboards, games, or interactive browser experiences where layout, typography, color, components, animation, accessibility, and mobile behavior matter.
---

# Polished Web UI

## Overview

Build complete, runnable frontend experiences that feel production-ready when opened in a browser. Favor tasteful restraint, clear hierarchy, responsive behavior, accessible contrast, and interaction polish over placeholder-looking layouts.

## Core Workflow

1. Start with the actual usable screen, not a marketing page, unless the user explicitly asks for a landing page.
2. Establish the information hierarchy: one primary heading, supporting copy, clear actions, and scannable sections.
3. Build mobile-first layouts with Flexbox or CSS Grid, then enhance at 480px, 768px, 1024px, and 1280px breakpoints.
4. Add states for loading, empty, hover, focus, active, disabled, modal, and error cases when the UI implies them.
5. Verify that text does not overlap, buttons remain touch-friendly, focus states are visible, and the first viewport looks impressive.

## Layout And Spacing

- Use a consistent spacing scale: 4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px.
- Add generous whitespace and avoid crowding elements.
- Use CSS Grid or Flexbox for layout; never use tables for layout.
- Keep readable content in a max-width container around 960px to 1200px with auto margins.
- Use stable dimensions for fixed-format elements such as boards, toolbars, tiles, counters, and icon buttons so hover states or changing labels do not shift the layout.

## Typography

- Use `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.
- Keep body text at 16px or larger with 1.5 to 1.7 line height.
- Use 1.1 to 1.3 line height for headings.
- Limit body copy to roughly 65 to 75 characters per line.
- Do not scale font size directly with viewport width; use responsive layout, wrapping, or container-aware sizing instead.

## Color And Accessibility

- Start with a neutral gray palette and one purposeful accent color.
- Ensure WCAG AA contrast for text, aiming for at least 4.5:1.
- Use semantic colors intentionally for primary, success, warning, and error states.
- For dark mode, use dark grays such as `#1a1a2e` and `#16213e`, not pure black.
- Avoid one-note palettes dominated by variations of a single hue.

## Components

- Buttons need clear hierarchy: primary filled, secondary outlined, tertiary text-only.
- Cards should use subtle borders or shadows, consistent padding, and restrained rounded corners.
- Forms need labels, 44px or larger touch targets, clear validation, and visible focus states.
- Modals need a backdrop overlay, centered content, a sensible max-width, and an accessible close button.
- Prefer familiar icons for tool buttons and pair unfamiliar icons with tooltips.

## Interactions And Animation

- Add hover and active states for all interactive elements.
- Use 150ms to 300ms ease transitions for color, background, transform, and opacity.
- Use subtle fade-in or slide-up entrance motion.
- Animate with transform and opacity when possible for performance.
- Provide immediate visual feedback for user actions.

## Responsive Design

- Design mobile-first, then progressively enhance.
- Prefer relative units such as rem, %, vw, and vh where appropriate.
- Maintain 44px minimum tap targets.
- Ensure long labels wrap cleanly and never escape buttons, cards, panels, or navigation.
- Test the UI at common widths: 480px, 768px, 1024px, and 1280px.

## Games And Interactive Experiences

- Use `<canvas>` or DOM rendering based on complexity.
- Implement the loop with `requestAnimationFrame`.
- Handle keyboard, mouse, and touch input cleanly.
- Include a start screen, HUD or score display, and game-over state.
- Use procedural or sprite-based graphics rather than placeholder rectangles.
- Add visual feedback such as particles, screen shake, flashes, or stateful animation where appropriate.
- Add sound effects with the Web Audio API when it improves the experience.
- Target 60fps and keep render loops efficient.

## Single-File Projects

- Put CSS in `<style>` and JavaScript in `<script>`.
- Use modern ES6+ JavaScript without requiring build tools.
- Include all required assets inline, including SVG icons, gradients, and favicon data URIs.
- Produce complete, runnable code with no placeholders or TODOs.
- Make the file immediately openable in a browser.
