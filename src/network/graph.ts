import { ResearcherAgent } from "../agents/researcherAgent";
import { CuratorAgent } from "../agents/curatorAgent";
import { WriterAgent } from "../agents/writerAgent";
import { CritiquerAgent } from "../agents/critiquerAgent";
import { EditorAgent } from "../agents/editorAgent";
import { PublisherAgent } from "../agents/publisherAgent";
import { RunnableSequence } from "@langchain/core/runnables";

interface GraphInput {
  topic: string;
  outputDir?: string; // Optional output directory for published files
  githubUsername?: string; // Optional GitHub username for Pages deployment
  repoName?: string; // Optional repository name for Pages deployment
}

interface GraphOutput {
  topic: string;
  title: string;
  content: string;
  filePath: string;
  publishedDate: string;
  url: string; // URL where the content is published
  metadata: {
    wordCount: number;
    readingTime: number;
    targetAudience: string;
    keyTakeaways: string[];
    sources: string[];
    metaDescription: string;
    keywords: string[];
    publishedDate: string;
    lastModified: string;
  };
  changeLog: Array<{
    type: "title" | "content" | "structure" | "seo";
    description: string;
    before?: string;
    after?: string;
  }>;
}

export async function createBlogChain() {
  const researcherAgent = new ResearcherAgent();
  const curatorAgent = new CuratorAgent();
  const writerAgent = new WriterAgent();
  const critiquerAgent = new CritiquerAgent();
  const editorAgent = new EditorAgent();

  const chain = RunnableSequence.from([
    (input: GraphInput) => {
      // Initialize publisher with GitHub Pages config if provided
      const publisherAgent = new PublisherAgent(
        input.outputDir,
        input.githubUsername,
        input.repoName
      );
      return { input, publisherAgent };
    },
    async ({ input, publisherAgent }) => {
      // First, get research results
      const researchResult = await researcherAgent.execute({
        topic: input.topic,
      });

      // Then, pass to curator for filtering and analysis
      const curatedResult = await curatorAgent.execute({
        topic: input.topic,
        searchResults: researchResult.searchResults,
        summary: researchResult.summary,
      });

      // Generate initial blog post
      const blogPost = await writerAgent.execute({
        topic: input.topic,
        selectedResults: curatedResult.selectedResults,
        curatedSummary: curatedResult.curatedSummary,
        suggestedAngles: curatedResult.suggestedAngles,
      });

      // Get critique and feedback
      const critique = await critiquerAgent.execute({
        topic: input.topic,
        title: blogPost.title,
        content: blogPost.content,
        metadata: blogPost.metadata,
      });

      // Improve the content based on critique
      const finalPost = await editorAgent.execute({
        topic: input.topic,
        title: blogPost.title,
        content: blogPost.content,
        metadata: blogPost.metadata,
        critique: critique,
      });

      // Finally, publish the content
      const published = await publisherAgent.execute({
        topic: input.topic,
        title: finalPost.title,
        content: finalPost.content,
        metadata: finalPost.metadata,
        changeLog: finalPost.changeLog,
      });

      return {
        topic: input.topic,
        title: published.title,
        content: finalPost.content,
        filePath: published.filePath,
        publishedDate: published.publishedDate,
        url: published.url,
        metadata: published.metadata,
        changeLog: finalPost.changeLog,
      };
    },
  ]);

  return chain;
}

// Usage example:
// const chain = await createBlogChain();
// const result = await chain.invoke({
//     topic: "artificial intelligence trends 2024",
//     outputDir: "_posts",
//     githubUsername: "yourusername",
//     repoName: "blog"
// });
//
// This will:
// 1. Research the topic using the researcher agent
// 2. Curate and analyze the research results
// 3. Write an initial blog post draft
// 4. Get critique and feedback
// 5. Improve the content based on critique
// 6. Publish to GitHub Pages (if credentials provided)
// 7. Return the complete post details including URL
