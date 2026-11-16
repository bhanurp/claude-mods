export type Pr = {
  url: string
  repo: string
  num: number
  // open | draft | merged | closed | unknown
  status: string
  // can it merge: ready | conflicts | checks | behind | blocked | draft |
  // checking; '' for a merged or closed PR
  merge: string
  // approved | changes | needed; '' = none or not open
  review: string
  // checks: failing | running | passing; '' = none or not open
  ci: string
  // who wrote it: yes = the signed-in gh user, no = someone else, '' = unknown
  mine: string
  // review threads not yet resolved; -1 = unknown or not an open PR
  unresolved: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-prs': {
      prs: Shaped<Pr[]>
      // last message to show; '' = none
      notice: Shaped<string>
      // URLs of PRs dismissed from the band; /prs clears the list
      dismissed: Shaped<string[]>
      // second filter: comments | ci | conflicts | changes | review | approved | ready; '' = none
      attn: Shaped<string>
      // show only PRs the signed-in gh user wrote
      onlyMine: Shaped<boolean>
      // status the band shows: all | open | draft | merged | closed | unknown
      filter: Shaped<string>
      // is the band above the prompt shown
      isShown: Shaped<boolean>
    }
  }
}
