import { replayCommand } from './replay-command'

/**
 * Re-evaluates the replies of a stored run with the rules as they are now, without paying:
 *   npm run eval:replay -- evals/runs/<timestamp>/results.json
 * Writes report.replay.md beside the results. The measurement itself is never rewritten.
 *
 * A v1 run is not replayed (SPEC §10.2): the command says it is not comparable, writes nothing
 * and exits 3. Exit 2 is a usage error and 1 any other failure.
 */
try {
  process.exit(replayCommand(process.argv[2]))
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exit(1)
}
