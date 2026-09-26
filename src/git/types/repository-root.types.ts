/**
 * Finds the repository a file belongs to, bounded by one directory and
 * memoized for the life of the finder.
 */
export interface RepositoryRootFinder {
  /**
   * The root of the repository containing `filePath`, or undefined when none
   * lies between the file and the boundary.
   */
  find(filePath: string): Promise<string | undefined>;
}
