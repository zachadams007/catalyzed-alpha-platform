import { AlgorithmStory } from "@/components/algorithm/AlgorithmStory";

/**
 * The Algorithm tab (/core) - a scroll-driven, truthful story of the engine:
 * where data comes from, how it travels stage to stage, which agents run, and
 * where the results land. See src/viz/pipelineModel.ts for the fidelity
 * contract (this page renders the engine's own configuration).
 */
export function CoreGuide() {
  return <AlgorithmStory />;
}
