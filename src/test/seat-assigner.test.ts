import { describe, expect, it } from "vitest";
import { SeatMap } from "../forking/seat-map.ts";
import { NoFreeSeatsError, SeatAssigner } from "../network/seat-assigner.ts";
import { ConnectionTracker } from "../network/connection-tracker.ts";

describe("SeatAssigner", () => {
  it("claims seats in order as new identities join", () => {
    const assigner = new SeatAssigner(new SeatMap(), ["seat-A", "seat-B", "seat-C"]);
    expect(assigner.claimSeat("user-1")).toBe("seat-A");
    expect(assigner.claimSeat("user-2")).toBe("seat-B");
    expect(assigner.claimSeat("user-3")).toBe("seat-C");
  });

  it("is idempotent: the same identity always gets the same seat back", () => {
    const assigner = new SeatAssigner(new SeatMap(), ["seat-A", "seat-B"]);
    const first = assigner.claimSeat("user-1");
    assigner.claimSeat("user-2");
    expect(assigner.claimSeat("user-1")).toBe(first);
  });

  it("seatFor finds an existing assignment without claiming a new one", () => {
    const assigner = new SeatAssigner(new SeatMap(), ["seat-A", "seat-B"]);
    expect(assigner.seatFor("user-1")).toBeUndefined();
    assigner.claimSeat("user-1");
    expect(assigner.seatFor("user-1")).toBe("seat-A");
  });

  it("throws NoFreeSeatsError once every seat is claimed by a different identity", () => {
    const assigner = new SeatAssigner(new SeatMap(), ["seat-A", "seat-B"]);
    assigner.claimSeat("user-1");
    assigner.claimSeat("user-2");
    expect(() => assigner.claimSeat("user-3")).toThrow(NoFreeSeatsError);
  });

  it("isFull reflects whether every seat has a claimed identity", () => {
    const assigner = new SeatAssigner(new SeatMap(), ["seat-A", "seat-B"]);
    expect(assigner.isFull).toBe(false);
    assigner.claimSeat("user-1");
    expect(assigner.isFull).toBe(false);
    assigner.claimSeat("user-2");
    expect(assigner.isFull).toBe(true);
  });

  it("a pre-populated SeatMap (e.g. from a materialized fork) is respected", () => {
    const seatMap = new SeatMap();
    seatMap.assign("seat-A", "user-1");
    const assigner = new SeatAssigner(seatMap, ["seat-A", "seat-B"]);
    expect(assigner.seatFor("user-1")).toBe("seat-A");
    expect(assigner.claimSeat("user-2")).toBe("seat-B");
  });
});

describe("ConnectionTracker", () => {
  it("defaults to disconnected for a seat never set", () => {
    const tracker = new ConnectionTracker();
    expect(tracker.isConnected("seat-A")).toBe(false);
  });

  it("tracks connected status independently per seat", () => {
    const tracker = new ConnectionTracker();
    tracker.setConnected("seat-A", true);
    expect(tracker.isConnected("seat-A")).toBe(true);
    expect(tracker.isConnected("seat-B")).toBe(false);

    tracker.setConnected("seat-A", false);
    expect(tracker.isConnected("seat-A")).toBe(false);
  });
});
