# Design Guidelines

This document outlines the visual and interaction requirements for the FinanceLedger application. All UI/UX decisions should align with these principles to ensure a cohesive and premium experience.

## Core Aesthetic: Apple-Style

The application aims for a "Native" or "Apple-like" feel, prioritizing clarity, smooth transitions, and tactile feedback.

### 1. Typography
- **Primary Font**: Geist (Sans & Mono).
- **Hierarchy**: Use font weights (`font-medium`, `font-bold`) and tracking (`tracking-tight`, `tracking-widest`) rather than large font sizes to create contrast.
- **Precision**: Monetary values and categories should often use **Monospace** variants for better vertical alignment and a professional, "ledger" feel.

### 2. Layout & Spacing
- **High Density**: Prefer compact lines and grids that allow scanning thousands of transactions without excessive scrolling.
- **Proximity**: Related information (description, category, account) should be grouped closely on a single line.
- **Alignment**: Use fixed-width columns for values and amounts to ensure consistent vertical scanning.

### 3. Visual Language
- **Dark Mode First**: The system is designed for a deep, high-contrast dark mode.
- **Borders & Separators**: Use extremely subtle borders (`border-border/30`) or separators to define structure without adding visual noise.
- **Frosted Glass**: Use `backdrop-blur` for sticky headers and overlays to provide a sense of depth and hierarchy.
- **Color with Purpose**: 
    - **Neutral**: Most data should be muted or neutral (`muted-foreground`).
    - **Destructive (Red)**: Expenses and negative movements.
    - **Success (Green)**: Income and positive movements.
    - **Primary**: Brand/action highlights (e.g., category badges).

### 4. Motion & Interaction
- **Tactile Feedback**: Interactive elements should respond to hover and active (click) states with subtle scale changes or background shifts (e.g., `active:scale-[0.99]`).
- **Smooth Transitions**: Any expansion or layout change (like showing transaction details) must be animated with smooth transitions (e.g., `transition-all duration-300`).
- **Scroll Behavior**: Always use `scroll-smooth` for navigation and infinite scroll.

---

## Component Specifics

### Ledger Rows
- **Idle State**: One line per transaction. Full width. Subtle bottom border.
- **Hover State**: Gentle background highlight (`hover:bg-muted/15`).
- **Expanded State**: Reveal full double-entry details (debits/credits) in a secondary, recessed panel with its own subtle styling.

### Headers
- **Sticky Behavior**: Date headers must stick to the top during scrolling.
- **Date Format**: `[Day of Week], [Day] [Month] [Year]` (e.g., *Sunday, 08 March 2026*).
- **Styling**: Small, uppercase, bold tracking for a "system" look.

### Tags & Badges
- **Categories**: Should show the full hierarchy (e.g., `expenses:food:grocery`).
- **Style**: Small, high-contrast text on a low-opacity background for a modern, flat look.
