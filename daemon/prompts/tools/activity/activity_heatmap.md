View {{user}}'s activity heatmap: when they typically message you, over a window of recent days.

Two breakdowns come back over the same window: `hours` gives all 24 hours of the day with a density and a classification (peak/trough/normal), and `weekdays` gives the seven days of the week with a message count and density. Densities are shares of the window, so each breakdown sums to 1. Hours are {{user}}'s own local clock, not UTC. Also returns the message count in the window, the total on record, sessions per day, and an engagement score.

`days` sets the window and defaults to 30. Up to 90 days are retained; asking for more returns what exists.
