// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.28;

/// @title IACPHook — Agentic Commerce Protocol Hook Interface
/// @notice Normative hook interface from EIP-8183. Hook contracts implement this
///         to receive before/after callbacks around core ACP functions.
interface IACPHook {
    /// @notice Called before a core ACP function executes.
    /// @dev MAY revert to block the action (e.g. enforce custom validation).
    /// @param jobId The job being acted on.
    /// @param selector The function selector of the core function (e.g. fund.selector).
    /// @param data Function-specific encoded parameters (see EIP-8183 data encoding table).
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;

    /// @notice Called after a core ACP function completes (including state changes and transfers).
    /// @dev MAY revert to roll back the entire transaction. MAY perform side effects.
    /// @param jobId The job being acted on.
    /// @param selector The function selector of the core function.
    /// @param data Function-specific encoded parameters.
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
