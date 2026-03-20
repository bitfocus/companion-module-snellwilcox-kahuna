## Snell & Wilcox Kahuna

Written to interface with the first generation Kahuna Production Switchers. Comms via Moxa NPort to the switchers serial ports. Requires 2 ports.

### Tested Moxa Configuration

| Setting      | Macro Serial | Tally Serial |
| ------------ | ------------ | ------------ |
| Baud Rate    | 38400        | 38400        |
| Parity       | Odd          | Odd          |
| Data Bits    | 8            | 8            |
| Stop Bits    | 1            | 1            |
| Flow Control | None         | None         |
| FIFO         | Enable       | Enable       |
| Interface    | RS-422       | RS-422       |

| Setting           | Macro Operation | Tally Operation |
| ----------------- | --------------- | --------------- |
| Operation Mode    | TCP Server      | TCP Server      |
| TCP alive time    | 0               | 0               |
| Inactivity time   | 0               | 0               |
| Max Connection    | 4               | 4               |
| Ignore Jammed     | Yes             | Yes             |
| Allow Driver      | No              | No              |
| Local TCP Port    | 4003            | 4004            |
| Command Port      | 968             | 969             |
| Data Packing      |                 |                 |
| Length            | 0               | 0               |
| Delimiter 1       | 00              | 00              |
| Delimiter 2       | 00              | 00              |
| Delimiter Process | Do Nothing      | Do Nothing      |
| Force Transmit    | 15              | 15              |

### Actions

- Trigger Macro

### Value Feedbacks

- Tally

### Variables

- Tally

Tally feedback and variable report the most recently tallied crosspoint. Does not support multiple tallies.
