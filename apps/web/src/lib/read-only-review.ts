import { createContext, use } from "react";

/** Review controls stay writable unless a whole surface explicitly opts out. */
export const ReadOnlyReview = createContext(false);
export const useReadOnlyReview = () => use(ReadOnlyReview);
