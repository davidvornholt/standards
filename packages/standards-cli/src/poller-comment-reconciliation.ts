import { deleteComment } from './poller-github-write';

type CommentContext = {
  readonly token: string | null;
  readonly repo: string;
};

export const earliestCommentId = (
  commentIds: ReadonlyArray<number>,
): number | null =>
  commentIds.reduce<number | null>(
    (earliest, commentId) =>
      earliest === null || commentId < earliest ? commentId : earliest,
    null,
  );

export const retainEarliestComment = async (
  context: CommentContext,
  commentIds: ReadonlyArray<number>,
): Promise<number | null> => {
  const retainedId = earliestCommentId(commentIds);
  for (const commentId of commentIds) {
    if (commentId !== retainedId) {
      // biome-ignore lint/performance/noAwaitInLoops: GitHub mutations are deliberately serialized to avoid secondary rate limits.
      await deleteComment(context.token, context.repo, commentId);
    }
  }
  return retainedId;
};
